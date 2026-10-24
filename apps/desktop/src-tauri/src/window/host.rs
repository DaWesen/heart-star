//! 宿主迁移：SetParent
//!
//! 单次形态切换的固定序列（顺序不可调换）：
//!   hide → 改样式 → SetParent → SetWindowPos → show
//! 先隐藏再显示，规避绝大部分闪烁与重绘撕裂。

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    SetParent, SetWindowPos, ShowWindow, SWP_FRAMECHANGED, SWP_NOZORDER, SW_HIDE, SW_SHOWNA,
};

use super::WindowError;

#[derive(Debug, Clone, Copy, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn to_win32(&self) -> RECT {
        RECT {
            left: self.x,
            top: self.y,
            right: self.x + self.width,
            bottom: self.y + self.height,
        }
    }
}

pub fn hide(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// 用 SW_SHOWNA：显示但不激活，避免抢焦点
pub fn show(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNA);
    }
}

/// 挂载到宿主窗口（面板形态）
pub fn attach_to(hwnd: HWND, host: HWND) -> Result<(), WindowError> {
    unsafe {
        if SetParent(hwnd, Some(host)).is_invalid() {
            return Err(WindowError::ParentFailed);
        }
    }
    Ok(())
}

/// 脱离宿主（桌面形态）
pub fn detach(hwnd: HWND) -> Result<(), WindowError> {
    unsafe {
        if SetParent(hwnd, None).is_invalid() {
            return Err(WindowError::ParentFailed);
        }
    }
    Ok(())
}

pub fn place(hwnd: HWND, area: Rect) -> Result<(), WindowError> {
    let _rect: RECT = area.to_win32();
    unsafe {
        // M1 实现：子窗口坐标需经 MapWindowPoints 换算到宿主客户区坐标系
        let _ = SetWindowPos(
            hwnd,
            None,
            area.x,
            area.y,
            area.width,
            area.height,
            SWP_FRAMECHANGED | SWP_NOZORDER,
        );
    }
    Ok(())
}
