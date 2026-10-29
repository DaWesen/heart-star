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

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetCursorPos, GetWindowRect, SetWindowPos, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
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
    /// 这次按下**真的拖动过**（越过 slop 阈值）。单击一下不算 —— 见 drag_move
    dragged: bool,
    /// 拖拽起点：光标位置与窗口左上角，用于计算位移
    origin_cursor: (i32, i32),
    origin_window: (i32, i32),
}

/// 窗口句柄的原子副本。移动线程要用它，但不能为此去抢 `HOOK_STATE` 的锁 ——
/// 那把锁在每条鼠标消息上都要过一遍，多一个高频竞争者只会平添争用。
static HWND_RAW: AtomicIsize = AtomicIsize::new(0);

/// 待应用的窗口位置（屏幕物理像素）。
///
/// 钩子只负责**写**目标位置，真正的 `SetWindowPos` 由 `spawn_window_mover`
/// 那条线程做 —— 理由见那里的注释。
static PENDING_X: AtomicI32 = AtomicI32::new(0);
static PENDING_Y: AtomicI32 = AtomicI32::new(0);
/// 是否有尚未落地的移动。采用"最新值覆盖"而不是排队：
/// 位置只认最后算出来的那个，中间的都过期了。
static PENDING_MOVE: AtomicBool = AtomicBool::new(false);

/// 移动线程的应用间隔。
///
/// 60Hz 的窗口移动肉眼已经完全连续 —— 关键是它**恒定**：
/// 无论鼠标每秒发 100 条还是 1000 条消息，窗口都只按这个节奏动，
/// 鼠标消息洪流被彻底挡在窗口之外。
const WINDOW_MOVE_INTERVAL_MS: u64 = 16;

/// 拖拽窗口的移动线程。启动时调一次。
///
/// 为什么不在钩子里直接 `SetWindowPos`：钩子回调位于全局鼠标消息路径上，
/// 在里面搬窗口等于让"每动一下鼠标"都触发一次跨进程合成 ——
/// 透明 + 分层的 WebView2 每动一次都要重新合成一层，
/// 实测十几次拖拽就能把渲染进程压崩（日志上是 window_impl.cc 报错 + renderer 退出）。
///
/// 挪到独立线程之后，钩子这一侧只剩两个原子写，
/// 而窗口移动天然被合并成恒定 60Hz、且每次都用最新坐标。
pub fn spawn_window_mover() {
    thread::spawn(|| loop {
        thread::sleep(Duration::from_millis(WINDOW_MOVE_INTERVAL_MS));

        if !PENDING_MOVE.swap(false, Ordering::SeqCst) {
            continue;
        }
        let raw = HWND_RAW.load(Ordering::SeqCst);
        if raw == 0 {
            continue;
        }
        let x = PENDING_X.load(Ordering::SeqCst);
        let y = PENDING_Y.load(Ordering::SeqCst);

        unsafe {
            let _ = SetWindowPos(
                to_hwnd(raw),
                None,
                x,
                y,
                0,
                0,
                // ASYNCWINDOWPOS：不等这次移动真正生效就返回。
                // 窗口属于主线程，同步等待会把本线程挂到主线程的消息处理上，
                // 而此刻主线程很可能正因为别的事卡着 —— 那正是一处死锁。
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
            );
        }
    });
}

/// 位移超过这么多物理像素才算"在拖"，不是"手抖了一下"。
///
/// 没有这个阈值的话，单击也会先触发一次"被拎起来"：
/// 按下到松开之间光标常常有一两个像素的位移，
/// 于是摸一下她会同时播"被摸"和"被拎起来"两个动作，看起来像抽搐。
const DRAG_SLOP_PX: i32 = 4;

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

/// 最近一次看到的指针位置（屏幕物理像素）。
///
/// 钩子在全局鼠标消息路径上，回调里除了必要判定不能做重活，
/// 所以这里只做两个原子写，真正的换算与 IPC 交给 `ipc::spawn_gaze_pump`。
static CURSOR_X: AtomicI32 = AtomicI32::new(0);
static CURSOR_Y: AtomicI32 = AtomicI32::new(0);
/// 是否有可用的指针位置。钩子卸载（面板形态）后置 false。
static CURSOR_VALID: AtomicBool = AtomicBool::new(false);

/// 取最近一次指针位置。钩子未安装时返回 None —— 此时没有任何指针来源。
pub fn cursor() -> Option<(i32, i32)> {
    if !CURSOR_VALID.load(Ordering::Relaxed) {
        return None;
    }
    Some((
        CURSOR_X.load(Ordering::Relaxed),
        CURSOR_Y.load(Ordering::Relaxed),
    ))
}

/// 指针位置，且**确实落在宠物窗口上**。
///
/// 先按窗口矩形粗筛一遍再上报：命中反馈只需要"点在宠物身上"，
/// 为桌面上每一次点击都发一条 IPC 没有意义。
/// 矩形内的精确判定（模型的形状）交给渲染层。
fn cursor_over_pet() -> Option<(i32, i32)> {
    let (x, y) = cursor()?;
    let guard = HOOK_STATE.lock().ok()?;
    let state = guard.as_ref()?;
    let hwnd = to_hwnd(state.hwnd);
    if !is_inside_window(hwnd, POINT { x, y }) {
        return None;
    }
    Some((x, y))
}

fn note_cursor(x: i32, y: i32) {
    CURSOR_X.store(x, Ordering::Relaxed);
    CURSOR_Y.store(y, Ordering::Relaxed);
    CURSOR_VALID.store(true, Ordering::Relaxed);
}

/// 形态切换请求。由托盘菜单置位，由主进程的监管线程取走。
///
/// 为什么要绕一圈：钩子是全局静态的，拿不到 `PetWindow`，而形态切换必须
/// 经过状态机（禁止业务代码直接 `SetParent`）。所以这里只置一个标志位，
/// 真正的切换交给持有状态机的那一侧执行。
///
/// 曾经这里也接"双击宠物"，后来去掉了：双击在桌宠上是个说不通的交互 ——
/// 现实里没什么东西是要敲两下才会跟你走的，而它又会和"单击 = 摸一下"
/// 抢同一批点击（两次单击必然先被判成一次双击，反应动作就丢了）。
/// 形态切换统一走托盘菜单，语义上也更像"打开/收起"。
static TOGGLE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 取走并清除切换请求。
pub fn take_toggle_request() -> bool {
    TOGGLE_REQUESTED.swap(false, Ordering::Relaxed)
}

/// 请求一次形态切换。任何入口（目前只有托盘菜单）都能直接调用。
///
/// 刻意**不做命中判定**：面板形态下钩子已卸载、状态为空，
/// 把判定塞进来的话托盘菜单会静默失效 ——
/// 用户点了"切换形态"却毫无反应，日志里也什么都看不到。
pub fn request_toggle() {
    TOGGLE_REQUESTED.store(true, Ordering::Relaxed);
}

/// 点击上报通道。
///
/// 钩子拿不到 AppHandle，发不了 IPC —— 与形态切换同样的处理方式：
/// 这里只把"按下了"投递进通道，真正的坐标换算与下发由 `ipc` 的线程做。
/// 用 channel 而不是"标志位 + 轮询"：点击是稀疏事件，为它每 16ms 醒一次
/// 线程没有意义，而阻塞在 recv 上既零开销又是立刻响应的。
static TAP_TX: Mutex<Option<Sender<(i32, i32)>>> = Mutex::new(None);

/// 拖拽的两个阶段 —— 宠物被鼠标"拎起来"和"放下去"。
///
/// 为什么要单独报：这是桌宠独有的交互，动作上必须和"被摸一下"区分开。
/// 都塞进 tap 的话，上层再也分不清用户是想摸她还是想挪她。
#[derive(Clone, Copy, Debug)]
pub enum DragPhase {
    Grab,
    Drop,
}

/// 拖拽阶段上报通道。与点击同理：钩子拿不到 AppHandle，只能投递。
static DRAG_TX: Mutex<Option<Sender<DragPhase>>> = Mutex::new(None);

/// 取走拖拽接收端。**只能调用一次**（启动时）。
pub fn take_drag_receiver() -> Receiver<DragPhase> {
    let (tx, rx) = channel::<DragPhase>();
    if let Ok(mut guard) = DRAG_TX.lock() {
        *guard = Some(tx);
    }
    rx
}

fn request_drag(phase: DragPhase) {
    if let Ok(guard) = DRAG_TX.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(phase);
        }
    }
}

/// 取走点击接收端。**只能调用一次**（启动时）。
pub fn take_tap_receiver() -> Receiver<(i32, i32)> {
    let (tx, rx) = channel::<(i32, i32)>();
    if let Ok(mut guard) = TAP_TX.lock() {
        *guard = Some(tx);
    }
    rx
}

/// 上报一次点击。坐标是**屏幕物理像素**，换算交给接收方。
fn request_tap(x: i32, y: i32) {
    if let Ok(guard) = TAP_TX.lock() {
        if let Some(tx) = guard.as_ref() {
            // 通道没人收（线程已退出）时 send 会失败，忽略即可：
            // 点击反馈丢了只是一次没反应，不值得为此打断钩子链
            let _ = tx.send((x, y));
        }
    }
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

    HWND_RAW.store(hwnd.0 as isize, Ordering::SeqCst);

    *state = Some(HookState {
        hwnd: hwnd.0 as isize,
        // 桌面形态下窗口是穿透的，以此为初始态
        transparent: true,
        dragging: false,
        dragged: false,
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

    // 拖拽**中途**卸载钩子（切面板形态）时必须补发一次"被放下"：
    // 钩子没了就再也收不到 WM_LBUTTONUP，而"被拎起来"是个循环动作 ——
    // 少了这一下她会永远挂在半空晃，只有再摸她一下才能落地。
    let mut held = false;
    if let Ok(mut state) = HOOK_STATE.lock() {
        if let Some(s) = state.as_ref() {
            held = s.dragging && s.dragged;
        }
        *state = None;
    }
    if held {
        request_drag(DragPhase::Drop);
    }
    // 面板形态下窗口是宿主的子窗口，由宿主摆位，不该再由拖拽线程挪动
    HWND_RAW.store(0, Ordering::SeqCst);
    PENDING_MOVE.store(false, Ordering::SeqCst);
    // 钩子没了就没有指针来源了，视线该归正而不是停在最后一次的方向上 ——
    // 否则宠物在面板里会一直斜眼看着用户刚才待过的地方。
    CURSOR_VALID.store(false, Ordering::Relaxed);
}

/// 钩子回调。必须 `extern "system"`，且不得 panic 跨 FFI 边界。
extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // 失败不影响钩子链：即便这一帧没判定成功，也必须把消息传下去
        let _ = update_click_through();

        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                // 单击 = 摸一下。命中判定与动作反馈都在渲染层。
                // 形态切换不再绑到点击上 —— 理由见 TOGGLE_REQUESTED 的注释。
                if let Some((x, y)) = cursor_over_pet() {
                    request_tap(x, y);
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
    // 顺手记下指针位置：视线跟随要用，而这里已经取过一次了 ——
    // 再取一遍等于在同一个消息里多一次系统调用。
    note_cursor(pt.x, pt.y);

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
    state.dragged = false;
    state.origin_cursor = (pt.x, pt.y);
    state.origin_window = (rect.left, rect.top);
    Ok(())
}

fn drag_move() -> Result<(), ()> {
    let mut pt = POINT::default();
    unsafe {
        GetCursorPos(&mut pt).map_err(|_| ())?;
    }

    let mut guard = HOOK_STATE.lock().map_err(|_| ())?;
    let state = guard.as_mut().ok_or(())?;
    if !state.dragging {
        return Ok(());
    }

    // "被拎起来"只在越过 slop 时上报一次 —— 见 DRAG_SLOP_PX 的注释。
    // 放在这里而不是 begin_drag：按下那一刻还不知道用户是要摸她还是挪她。
    if !state.dragged {
        let dx = pt.x - state.origin_cursor.0;
        let dy = pt.y - state.origin_cursor.1;
        if dx.abs() >= DRAG_SLOP_PX || dy.abs() >= DRAG_SLOP_PX {
            state.dragged = true;
            request_drag(DragPhase::Grab);
        }
    }

    // 这里**只记下目标位置**，真正的 SetWindowPos 由 spawn_window_mover 那条线程做。
    // 钩子里不做窗口操作的原因见该函数：它在全局鼠标消息路径上，
    // 而搬一个透明分层窗口是一次跨进程合成，每秒上百次会把渲染进程压崩。
    //
    // 中间消息被覆盖不会丢精度：位置是从**当前光标**算的，
    // 移动线程每次取的又是最新的目标值，等于天然合帧。
    let x = state.origin_window.0 + (pt.x - state.origin_cursor.0);
    let y = state.origin_window.1 + (pt.y - state.origin_cursor.1);
    drop(guard);

    PENDING_X.store(x, Ordering::SeqCst);
    PENDING_Y.store(y, Ordering::SeqCst);
    PENDING_MOVE.store(true, Ordering::SeqCst);
    Ok(())
}

fn end_drag() -> Result<(), ()> {
    let mut guard = HOOK_STATE.lock().map_err(|_| ())?;
    if let Some(state) = guard.as_mut() {
        // 只有真的拖动过才报"被放下"：光是按一下再松开不该有这一下，
        // 否则每次摸她都会跟一个放下的动作
        if state.dragged {
            request_drag(DragPhase::Drop);
        }
        state.dragging = false;
        state.dragged = false;
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
