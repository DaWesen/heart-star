//! WH_MOUSE_LL 全局鼠标钩子
//!
//! 为什么必须挂钩子：桌面形态下窗口带 WS_EX_TRANSPARENT，
//! **收不到任何鼠标消息**，无法知道指针是否悬停在宠物上。
//! 因此只能靠全局钩子判定，再动态切换穿透状态。
//!
//! 两条硬性约束：
//!  1. 回调内**只做坐标判定与 SetWindowLongPtrW**，不得执行任何重活。
//!     它位于全局鼠标消息路径上，做重活会拖慢整个系统的鼠标响应。
//!  2. 判定采用两级：先用归一化 AABB 粗判（廉价），
//!     命中后再让渲染层做精确判定（Live2D Drawable / VRM 射线）。
//!
//! 另注：全局钩子易被杀软误报，必须配 EV 代码签名证书。

use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL,
};

use super::WindowError;

pub struct HookHandle(HANDLE);

/// 安装钩子。返回句柄，用于后续卸载。
pub fn install(hwnd: HWND) -> Result<HookHandle, WindowError> {
    // TODO(M1)：
    //  1. SetWindowsHookExW(WH_MOUSE_LL, Some(callback), None, 0)
    //  2. callback 内 GetPhysicalCursorPos（优于 GetCursorPos，DPI 敏感）
    //  3. 命中 → 移除 WS_EX_TRANSPARENT；离开 → 恢复
    //  4. 未处理消息必须 CallNextHookEx，否则会中断全局鼠标输入
    let _ = hwnd;
    let _ = (SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL);
    Err(WindowError::StyleFailed)
}

pub fn uninstall(handle: HookHandle) {
    unsafe {
        let _ = UnhookWindowsHookEx(HHOOK(handle.0 .0 as _));
    }
}

// 占位：windows crate 的 HHOOK 类型别名
#[allow(non_camel_case_types)]
type HHOOK = windows::Win32::UI::WindowsAndMessaging::HHOOK;
