//! Heart Star 壳层
//!
//! 职责：窗口生命周期、形态切换、鼠标钩子、托盘、快捷键、更新、看门狗。
//! 禁止：感知角色种类、渲染实现、AI 逻辑。

pub mod ipc;
pub mod lifecycle;
pub mod window;

use tauri::Manager;

pub fn run() {
    // DPI 感知必须在创建任何窗口之前设定，否则系统会对整个窗口做位图拉伸：
    // 内容模糊，且命中判定与窗口矩形错位。
    if !window::dpi::enable_per_monitor_v2() {
        eprintln!("[heart-star] 警告：未启用 Per-Monitor V2 DPI 感知，混合缩放屏下窗口会模糊");
    }

    tauri::Builder::default()
        .setup(|app| {
            // 宠物窗口在 tauri.conf.json 中定义（label = "pet"）。
            //
            // 为什么不用 WebviewWindowBuilder 动态创建：
            // 实测 Builder 的 .transparent(true) 没有作用到 WebView2 控件层——
            // 窗口本身透明了，但页面透明后透出的是 WebView2 默认的白色背景，
            // 表现为窗口顶部一大片白。写在配置里由 Tauri 在窗口创建源头应用，
            // 才能连 WebView2 背景一起透明。
            let pet = app
                .get_webview_window("pet")
                .expect("tauri.conf.json 中应配置 label=pet 的窗口");

            // 接管 HWND：应用桌面形态样式（穿透 / 不进任务栏 / 不抢焦点）、
            // 子类化窗口过程（拦截 WM_NCACTIVATE 等非客户区绘制）并挂钩子
            let hwnd = pet.hwnd()?;
            let mut pet_window = window::PetWindow::new(hwnd);
            if let Err(e) = pet_window.init() {
                eprintln!("[heart-star] 窗口样式应用失败: {e}");
            }
            if pet_window.hook_installed() {
                eprintln!("[heart-star] 鼠标钩子已安装");
            } else {
                eprintln!("[heart-star] 警告：鼠标钩子未安装，宠物将始终穿透（不可交互）");
            }
            eprintln!(
                "[heart-star] DPI 缩放 {:.0}%",
                pet_window.renderer_scale() * 100.0
            );

            // 交给主进程托管 —— 后续所有形态切换都经过这个状态机，
            // 业务代码不得直接操作窗口
            app.manage(pet_window);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Heart Star 启动失败");
}
