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

use std::sync::Mutex;

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
