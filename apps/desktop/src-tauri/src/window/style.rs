//! Win32 窗口样式位操作
//!
//! 关键决策：**不使用 WS_EX_LAYERED**。
//! layered 需要自行调用 UpdateLayeredWindow 提交位图，与 WebView2 的合成机制
//! 直接冲突，是黑边与闪烁的根源。透明度交给 Tauri 的 transparent 配置与
//! WebView2 的 DefaultBackgroundColor 实现。
//!
//! 三个样式位的含义：
//!   WS_EX_TRANSPARENT —— 鼠标穿透（穿透后窗口收不到鼠标消息，需配合钩子）
//!   WS_EX_TOOLWINDOW  —— 不进任务栏、不进 Alt-Tab
//!   WS_EX_NOACTIVATE  —— 点击时不抢焦点（桌宠抢焦点是致命体验问题）

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use super::WindowError;

/// 桌面形态：穿透 + 不进任务栏 + 不抢焦点，并**清除** WS_EX_LAYERED
pub fn apply_desktop_style(hwnd: HWND) -> Result<(), WindowError> {
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if current == 0 {
            return Err(WindowError::StyleFailed);
        }

        let style = (current as u32
            | WS_EX_TRANSPARENT.0
            | WS_EX_TOOLWINDOW.0
            | WS_EX_NOACTIVATE.0)
            & !WS_EX_LAYERED.0;

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);

        // 样式变更后必须触发一次重排，否则 WebView2 不会重新计算合成区域
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}

/// 面板形态：去掉穿透（子窗口需要正常接收鼠标消息），加 WS_CHILD
pub fn apply_panel_style(hwnd: HWND) -> Result<(), WindowError> {
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if current == 0 {
            return Err(WindowError::StyleFailed);
        }

        // 清除桌面形态的三个扩展位：子窗口需要正常接收鼠标消息
        let style = (current as u32
            & !WS_EX_TRANSPARENT.0
            & !WS_EX_TOOLWINDOW.0
            & !WS_EX_NOACTIVATE.0
            & !WS_EX_LAYERED.0);

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);

        // TODO(M1)：WS_CHILD 属于普通样式位（GWL_STYLE，非 GWL_EXSTYLE），
        // 必须在 SetParent 之后置位才稳定。待与 host.rs 联调时一并补齐。
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}
