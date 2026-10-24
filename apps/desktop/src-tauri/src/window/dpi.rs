//! DPI 感知与跨屏重算
//!
//! 桌宠必须处理混合 DPI：用户把宠物从 100% 缩放的显示器拖到 200% 的显示器，
//! 或面板与宠物窗口处于不同 DPI 的屏幕时，宿主迁移会导致缩放错乱。

use windows::Win32::Foundation::HWND;

/// 进程级启用 Per-Monitor V2。必须在创建任何窗口之前调用。
pub fn enable_per_monitor_v2() {
    // TODO(M1): SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
}

/// 迁移/跨屏后重算：通知渲染层同步 devicePixelRatio
pub fn sync_renderer_scale(hwnd: HWND) {
    // TODO(M1):
    //  1. MonitorFromWindow → GetDpiForMonitor(MDT_EFFECTIVE_DPI)
    //  2. 通过 IPC 下发 setBounds + 缩放系数给渲染层
    //  3. 渲染层重设 PixiJS resolution / three.js setPixelRatio
    // 顺序很重要：必须先让窗口完成迁移，再下发缩放，否则拿到的是旧 DPI
    let _ = hwnd;
}
