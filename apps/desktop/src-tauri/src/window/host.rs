//! 宿主迁移：SetParent
//!
//! 单次形态切换的固定序列（顺序不可调换）：
//!   hide → 改样式 → SetParent → SetWindowPos → show
//! 先隐藏再显示，规避绝大部分闪烁与重绘撕裂。
//!
//! 注意 windows 0.62 的约定：`SetParent` 第二参数是 `Option<HWND>`，
//! 挂载传 `Some(host)`，脱离传 `None`。返回值为原父窗口句柄（可能为 NULL）。
//! （0.58 时代是泛型 `Param<HWND>` 且不接受 Option —— 升级时需重新核对签名。）

use windows::Win32::Foundation::HWND;
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
        SetParent(hwnd, Some(host)).map_err(|_| WindowError::ParentFailed)?;
    }
    Ok(())
}

/// 脱离宿主（桌面形态）。传 None 即表示无父窗口。
pub fn detach(hwnd: HWND) -> Result<(), WindowError> {
    unsafe {
        SetParent(hwnd, None).map_err(|_| WindowError::ParentFailed)?;
    }
    Ok(())
}

pub fn place(hwnd: HWND, area: Rect) -> Result<(), WindowError> {
    unsafe {
        // M1 实现：子窗口坐标需经 MapWindowPoints 换算到宿主客户区坐标系
        SetWindowPos(
            hwnd,
            None,
            area.x,
            area.y,
            area.width,
            area.height,
            SWP_FRAMECHANGED | SWP_NOZORDER,
        )
        .map_err(|_| WindowError::StyleFailed)?;
    }
    Ok(())
}
