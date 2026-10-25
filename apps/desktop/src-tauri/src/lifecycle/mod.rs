//! 生命周期：看门狗、开机自启、托盘、更新
//!
//! 进程的存活管理都集中在这里，避免散落到各模块。
//! 看门狗与自动更新属于发布期功能（M6），托盘与开机自启属于 M1。

use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

/// 托盘图标。
///
/// 桌宠**必须**有它：宠物窗口无边框、不进任务栏，面板又是默认隐藏的。
/// 没有托盘，用户关掉面板之后就再也找不到任何入口，只能去任务管理器结束进程。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show_panel", "显示面板")
        .text("toggle_form", "切换形态")
        .separator()
        .text("quit", "退出")
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Heart Star")
        .menu(&menu)
        // 左键默认弹菜单：桌宠没有主窗口，左键单击该出现菜单而不是"无反应"
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            // 只显示，不改形态。用户可能只想想看面板而不想把宠物搬进去。
            "show_panel" => crate::show_panel(app),
            // 与双击宠物等价：桌面 → 面板，面板 → 桌面
            "toggle_form" => crate::window::hook::request_toggle(),
            "quit" => app.exit(0),
            _ => {}
        });

    // 图标可能没配（打包资源缺失时），这时宁可不带图标也不让托盘整个失败
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

const TRAY_ID: &str = "heart-star-main";

/// 看门狗。常驻程序进程死了必须能自愈 —— 桌宠没有窗口外壳，
/// 用户不会注意到它已经消失。
///
/// TODO(M6)：与 72h soak 测试一起落地。
pub fn spawn_watchdog(_app: AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// 开机自启。
///
/// TODO(M6)：注册表/任务计划实现，需要用户授权。
pub fn set_auto_launch(_app: &AppHandle, _enabled: bool) -> tauri::Result<()> {
    Ok(())
}
