//! Heart Star 壳层
//!
//! 职责：窗口生命周期、形态切换、鼠标钩子、托盘、快捷键、更新、看门狗。
//! 禁止：感知角色种类、渲染实现、AI 逻辑。

pub mod ipc;
pub mod lifecycle;
pub mod window;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 骨架阶段：窗口创建入口。
            // M1 实现顺序：
            //   1. 创建宠物窗口（transparent + frameless，URL 指向 renderer 开发/构建产物）
            //   2. window::PetWindow 接管其 HWND，应用桌面形态样式并挂钩子
            //   3. 面板窗口按需创建，创建后把宠物窗口 SetParent 进去
            let _handle = app.handle();
            // TODO(M1): 创建宠物窗口并接管
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Heart Star 启动失败");
}
