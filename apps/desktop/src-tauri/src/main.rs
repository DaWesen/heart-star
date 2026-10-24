// 防止 Windows 上弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    heart_star::run();
}
