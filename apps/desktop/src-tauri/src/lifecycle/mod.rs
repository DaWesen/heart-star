//! 生命周期：看门狗、开机自启、托盘、更新
//!
//! 常驻应用的三条底线：
//!  1. 渲染进程崩溃 → 自动重建，宠物不能就此消失
//!  2. 面板异常退出 → 强制把宠物回收到桌面形态（配合 window::PetWindow::ensure_valid）
//!  3. 内存超阈值 → 静默重启渲染进程，并保留宠物状态快照

/// 看门狗：监控渲染进程存活（骨架）
pub fn spawn_watchdog() {
    // TODO(M1)
}

/// 开机自启：写注册表 Run 项或建任务计划，避免需要管理员权限
pub fn set_auto_start(_enabled: bool) {
    // TODO(M3)
}

/// 托盘图标
pub fn setup_tray() {
    // TODO(M1)
}
