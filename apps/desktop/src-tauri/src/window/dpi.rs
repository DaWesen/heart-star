//! DPI 感知与跨屏重算
//!
//! 桌宠必须处理混合 DPI：用户把宠物从 100% 缩放的显示器拖到 200% 的显示器，
//! 或面板与宠物窗口处于不同 DPI 的屏幕时，宿主迁移会导致缩放错乱。
//!
//! 两条纪律：
//!
//!  1. 进程必须是 Per-Monitor V2。否则系统会对整个窗口做位图拉伸，表现为
//!     内容模糊 + 命中判定错位。tao 初始化时已经设过一次，这里再设一次并
//!     **回读确认**——设置函数在已设定后会拒绝生效，所以回读才算数。
//!
//!  2. 窗口几何一律用**物理像素**。逻辑尺寸只出现在与配置/渲染层对话时。
//!     `GetWindowRect` 与 `GetCursorPos` 在 PMv2 下同处物理坐标系，
//!     这正是 `hook.rs` 里矩形包含判定能直接成立的前提，不要改成逻辑坐标。
//!
//! 缩放系数变化后**由谁通知渲染层**：不是本模块。
//! 窗口过程（`proc.rs` 的 WM_DPICHANGED）与状态机（`PetWindow`）都只握着 HWND，
//! 拿不到 `WebviewWindow`，发不出 IPC。统一由 `lib.rs` 的形态监管线程轮询
//! `renderer_scale()` 并重发 `setBounds`（见 `ipc::announce`）。
//! 在这里假装"同步了"只会掩盖那条链路其实没接上的事实。

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::HiDpi::{
    GetAwarenessFromDpiAwarenessContext, GetDpiForWindow, GetThreadDpiAwarenessContext,
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    DPI_AWARENESS_PER_MONITOR_AWARE,
};

/// DPI 基准值。scale = dpi / 96，即 100% 缩放。
pub const BASELINE_DPI: u32 = 96;

/// 进程级启用 Per-Monitor V2。必须在创建任何窗口之前调用。
///
/// 返回值是**回读**到的实际感知级别，不是设置调用的成败：
/// tao 在初始化时已经调用过一次，本次调用大概率失败（ERROR_ACCESS_DENIED），
/// 那是预期的，不代表没生效。
pub fn enable_per_monitor_v2() -> bool {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())
            == DPI_AWARENESS_PER_MONITOR_AWARE
    }
}

/// 窗口当前所在显示器的缩放系数（1.0 = 100%，1.5 = 150%）。
///
/// 直接用 `GetDpiForWindow`：它返回窗口实际使用的 DPI，比
/// `MonitorFromWindow` → `GetDpiForMonitor` 两步走少一次可能失效的句柄传递。
pub fn scale_for(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        // 取不到就按 100% 处理，宁可不缩放也不要除出 NaN
        return 1.0;
    }
    dpi as f64 / BASELINE_DPI as f64
}
