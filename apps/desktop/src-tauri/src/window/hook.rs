//! WH_MOUSE_LL 全局鼠标钩子
//!
//! 为什么必须挂钩子：桌面形态下窗口带 WS_EX_TRANSPARENT，
//! **收不到任何鼠标消息**，无法知道指针是否悬停在宠物上。
//! 因此只能靠全局钩子判定，再动态切换穿透状态。
//!
//! 三条硬性约束：
//!  1. 回调内**只做坐标判定与样式位/位置修改**，不得执行任何重活。
//!     它位于全局鼠标消息路径上，做重活会拖慢整个系统的鼠标响应。
//!  2. 用状态缓存，只在**状态翻转时**才改样式。
//!     每帧无脑 SetWindowLongPtrW 会触发大量重绘，是性能杀手。
//!  3. 拖拽也由钩子驱动 —— 不投递 WM_NCLBUTTONDOWN。
//!     实测该消息会被 tao 的窗口过程吞掉（tao 有自己的 drag region 逻辑）；
//!     也不依赖前端 data-tauri-drag-region（它在 dev 模式加载外部 URL 时不一定生效）。
//!
//! 另注：全局钩子易被杀软误报，必须配 EV 代码签名证书。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetCursorPos, GetWindowRect, SetWindowPos, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
};

use super::WindowError;

/// 钩子回调所需的全局状态。
/// 存 `isize` 而非 `HWND`：裸指针不满足 Send，无法放进 static Mutex。
struct HookState {
    hwnd: isize,
    /// 当前是否处于穿透态。缓存它才能只在翻转时改样式。
    transparent: bool,
    /// 拖拽中
    dragging: bool,
    /// 拖拽起点：光标位置与窗口左上角，用于计算位移
    origin_cursor: (i32, i32),
    origin_window: (i32, i32),
}

static HOOK_STATE: Mutex<Option<HookState>> = Mutex::new(None);

/// 最近一次"指针进入宠物区域"的时间（Unix 秒）。供帧预算策略判断是否空闲。
///
/// 只在**进入**这一刻写一次，悬停期间的持续移动不刷新：
/// 钩子在全局鼠标消息路径上，每帧写共享状态是没必要的开销；
/// 而且"用户盯着宠物看"本就该被判定为空闲。
static LAST_INTERACTION_SECS: AtomicU64 = AtomicU64::new(0);

/// 供 `ipc::spawn_frame_budget_governor` 读取。
pub fn last_interaction_secs() -> u64 {
    LAST_INTERACTION_SECS.load(Ordering::Relaxed)
}

/// 形态切换请求。由双击宠物置位，由主进程的监管线程取走。
///
/// 为什么要绕一圈：钩子是全局静态的，拿不到 `PetWindow`，而形态切换必须
/// 经过状态机（禁止业务代码直接 `SetParent`）。所以钩子只置一个标志位，
/// 真正的切换交给持有状态机的那一侧执行。
static TOGGLE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 取走并清除切换请求。
pub fn take_toggle_request() -> bool {
    TOGGLE_REQUESTED.swap(false, Ordering::Relaxed)
}

/// 请求一次形态切换。任何入口（托盘菜单等）都能直接调用。
///
/// 刻意**不做命中判定**：判定是钩子那条路径（双击）的事。
/// 合在一起的话，面板形态下钩子已卸载、状态为空，托盘菜单会静默失效——
/// 用户点了"切换形态"却毫无反应，日志里也什么都看不到。
pub fn request_toggle() {
    TOGGLE_REQUESTED.store(true, Ordering::Relaxed);
}

/// 上一次按下的时刻与位置。双击判定要自己维护，理由见 `is_double_click`。
struct LastPress {
    /// Unix 毫秒
    at: u64,
    x: i32,
    y: i32,
}

static LAST_PRESS: Mutex<Option<LastPress>> = Mutex::new(None);

/// 双击时间上限。与 Windows 默认双击速度（500ms）保持一致，
/// 用户自己在控制面板里改过的话这里也没必要跟——桌宠只需要一个够用的值。
const DOUBLE_CLICK_MS: u64 = 500;
/// 位置容差（物理像素）。手抖不该算两次点击在不同位置。
const DOUBLE_CLICK_SLOP: i32 = 4;

/// 自己判双击，而不是依赖 `WM_LBUTTONDBLCLK`。
///
/// 实测双击消息到不了钩子：真正接收鼠标消息的是宠物的子层 WebView
/// （`Chrome_WidgetWin_1`），而顶层窗口的类是 tao 注册的 `Tauri Window`，
/// 类样式里**没有 `CS_DBLCLKS`** —— 没有这个位，系统压根不会生成双击消息。
/// 于是"双击宠物"长期以来只能靠运气： pane 形态、指针落在哪一层都会影响结果。
///
/// 自己在 `WM_LBUTTONDOWN` 上数次数就不看这些脸色了：
/// 间隔在阈值内、位置又没挪动，就是一次双击。另外也只有指针位于宠物上才算，
/// 否则双击桌面任何地方都会切换形态。
fn is_double_click() -> bool {
    // 先看指针是否在宠物上：`transparent == false` 即"当前未穿透"。
    {
        let Ok(guard) = HOOK_STATE.lock() else {
            return false;
        };
        if !guard.as_ref().is_some_and(|s| !s.transparent) {
            return false;
        }
    }

    let mut pt = POINT::default();
    if unsafe { GetCursorPos(&mut pt) }.is_err() {
        return false;
    }

    let Ok(mut last) = LAST_PRESS.lock() else {
        return false;
    };
    let now = now_ms();

    let is_double = last.as_ref().is_some_and(|prev| {
        now.saturating_sub(prev.at) <= DOUBLE_CLICK_MS
            && (pt.x - prev.x).abs() <= DOUBLE_CLICK_SLOP
            && (pt.y - prev.y).abs() <= DOUBLE_CLICK_SLOP
    });

    // 命中就清掉记录：否则三连击会被判成两次双击，形态来回跳
    *last = if is_double {
        None
    } else {
        Some(LastPress {
            at: now,
            x: pt.x,
            y: pt.y,
        })
    };

    is_double
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stamp_interaction() {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    LAST_INTERACTION_SECS.store(secs, Ordering::Relaxed);
}

fn to_hwnd(raw: isize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

/// 钩子句柄。持有它才能在形态切换时卸载钩子。
pub struct HookHandle(HHOOK);

pub fn install(hwnd: HWND) -> Result<HookHandle, WindowError> {
    let mut state = HOOK_STATE.lock().map_err(|_| WindowError::HookFailed)?;
    if state.is_some() {
        // 重复安装会导致旧句柄泄漏，且回调里出现两份状态
        return Err(WindowError::HookFailed);
    }

    let hhook = unsafe {
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0)
            .map_err(|_| WindowError::HookFailed)?
    };

    *state = Some(HookState {
        hwnd: hwnd.0 as isize,
        // 桌面形态下窗口是穿透的，以此为初始态
        transparent: true,
        dragging: false,
        origin_cursor: (0, 0),
        origin_window: (0, 0),
    });

    // 起始就当作刚交互过：否则 last_interaction 为初值 0，
    // 帧预算策略会一开机就把宠物判成空闲
    stamp_interaction();

    Ok(HookHandle(hhook))
}

pub fn uninstall(handle: HookHandle) {
    unsafe {
        let _ = UnhookWindowsHookEx(handle.0);
    }
    if let Ok(mut state) = HOOK_STATE.lock() {
        *state = None;
    }
}

/// 钩子回调。必须 `extern "system"`，且不得 panic 跨 FFI 边界。
extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // 失败不影响钩子链：即便这一帧没判定成功，也必须把消息传下去
        let _ = update_click_through();

        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                // 双击在这里自己判，不用 WM_LBUTTONDBLCLK —— 理由见 is_double_click
                if is_double_click() {
                    request_toggle();
                }
                let _ = begin_drag();
            }
            WM_MOUSEMOVE => {
                let _ = drag_move();
            }
            WM_LBUTTONUP => {
                let _ = end_drag();
            }
            _ => {}
        }
    }
    // 未处理消息必须传递，否则会中断全局鼠标输入
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// 判定指针是否落在宠物窗口内，并在状态翻转时切换穿透。
fn update_click_through() -> Result<(), ()> {
    let mut guard = HOOK_STATE.lock().map_err(|_| ())?;
    let state = guard.as_mut().ok_or(())?;

    // 拖拽过程中绝不切换穿透：拖到窗口外会立刻恢复穿透，
    // 导致窗口又收不到鼠标消息，拖拽半途中断。
    if state.dragging {
        return Ok(());
    }

    let hwnd = to_hwnd(state.hwnd);
    let mut pt = POINT::default();
    unsafe {
        // 用 GetCursorPos 而非 GetPhysicalCursorPos：
        // 下面要用 GetWindowRect 做矩形包含判定，两者必须同处一个坐标系。
        GetCursorPos(&mut pt).map_err(|_| ())?;
    }

    let inside = is_inside_window(hwnd, pt);
    if inside == state.transparent {
        let _ = super::style::set_click_through(hwnd, !inside);
        state.transparent = !inside;
        // 只在"指针刚刚进入"这一刻打时间戳，悬停期间的移动不刷新
        if inside {
            stamp_interaction();
        }
    }
    Ok(())
}

fn begin_drag() -> Result<(), ()> {
    let mut pt = POINT::default();
    unsafe {
        GetCursorPos(&mut pt).map_err(|_| ())?;
    }

    let mut guard = HOOK_STATE.lock().map_err(|_| ())?;
    let state = guard.as_mut().ok_or(())?;

    // 穿透态下鼠标消息本就不属于本窗口，不该拖拽
    if state.transparent {
        return Ok(());
    }

    let hwnd = to_hwnd(state.hwnd);
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).map_err(|_| ())?;
    }

    state.dragging = true;
    state.origin_cursor = (pt.x, pt.y);
    state.origin_window = (rect.left, rect.top);
    Ok(())
}

fn drag_move() -> Result<(), ()> {
    let mut pt = POINT::default();
    unsafe {
        GetCursorPos(&mut pt).map_err(|_| ())?;
    }

    let guard = HOOK_STATE.lock().map_err(|_| ())?;
    let state = guard.as_ref().ok_or(())?;
    if !state.dragging {
        return Ok(());
    }
    let hwnd = to_hwnd(state.hwnd);
    let x = state.origin_window.0 + (pt.x - state.origin_cursor.0);
    let y = state.origin_window.1 + (pt.y - state.origin_cursor.1);
    drop(guard);

    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}

fn end_drag() -> Result<(), ()> {
    let mut guard = HOOK_STATE.lock().map_err(|_| ())?;
    if let Some(state) = guard.as_mut() {
        state.dragging = false;
    }
    Ok(())
}

/// 廉价粗判：窗口矩形包含性测试。
/// 精确判定（Live2D Drawable / VRM 射线）交给渲染层，
/// 钩子里只做这个 —— 它在全局鼠标消息路径上。
fn is_inside_window(hwnd: HWND, pt: POINT) -> bool {
    let mut rect = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
    }
    pt.x >= rect.left && pt.x < rect.right && pt.y >= rect.top && pt.y < rect.bottom
}
