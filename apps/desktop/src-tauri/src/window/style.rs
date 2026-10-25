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
//!
//! 关于"停用后顶部浮出一条浅色横条"：
//! 那一层**不在样式位里**。样式位、非客户区尺寸、子窗口层次、背景画刷、穿透位
//! 全部排查过，都不是它。根因在 `proc.rs` —— 无边框窗口收到 `WM_NCACTIVATE` 时，
//! `DefWindowProc` 会按"停用态"重画一遍非客户区。必须在窗口过程里拦截，样式位做不到。

use windows::Win32::Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_ALLOW_NCPAINT, DWMWA_BORDER_COLOR,
    DWMWA_CAPTION_COLOR, DWMWA_NCRENDERING_POLICY, DWMWA_TRANSITIONS_FORCEDISABLED,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WINDOW_LONG_PTR_INDEX, WS_BORDER,
    WS_CAPTION, WS_CHILD, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX,
    WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

use crate::logging::log_warn;

/// 边框相关样式位。透明窗口只要残留其中任何一个，就会表现为一圈 1px 灰边。
const BORDER_BITS: u32 = WS_CAPTION.0
    | WS_THICKFRAME.0
    | WS_BORDER.0
    | WS_SYSMENU.0
    | WS_MINIMIZEBOX.0
    | WS_MAXIMIZEBOX.0;

const EX_BORDER_BITS: u32 =
    WS_EX_STATICEDGE.0 | WS_EX_CLIENTEDGE.0 | WS_EX_WINDOWEDGE.0 | WS_EX_DLGMODALFRAME.0;

use super::WindowError;

/// 读窗口样式位。
///
/// `GetWindowLongPtrW` 的返回值无法区分失败与"样式真的是 0"，只看返回值会误判。
/// 必须先清零 last-error 再调用 —— 这是 Win32 的固定套路，漏掉清零就会把
/// 上一次调用残留的错误码当成本次失败。
fn get_style(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> Result<u32, WindowError> {
    unsafe {
        SetLastError(ERROR_SUCCESS);
        let value = GetWindowLongPtrW(hwnd, index);
        if value == 0 && GetLastError() != ERROR_SUCCESS {
            return Err(WindowError::StyleFailed);
        }
        Ok(value as u32)
    }
}

/// 禁用 DWM 非客户区渲染。
///
/// 清掉 WS_CAPTION 等边框样式位还不够：DWM 仍可能自行绘制一层非客户区，
/// 必须显式关掉渲染策略，并禁止非客户区绘制。
///
/// 失败不向上传播：DWM 属性只影响观感，不阻断窗口形态迁移，
/// 让它把整个 `apply_*_style` 拖失败是代价不成比例的。
pub fn disable_nonclient_rendering(hwnd: HWND) {
    unsafe {
        let policy = DWMNCRP_DISABLED;
        if let Err(e) = DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            &policy as *const _ as *const core::ffi::c_void,
            core::mem::size_of::<i32>() as u32,
        ) {
            log_warn!("DWM 禁用非客户区失败: {e:?}");
        }

        let allow_ncpaint: i32 = 0; // FALSE
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_ALLOW_NCPAINT,
            &allow_ncpaint as *const _ as *const core::ffi::c_void,
            core::mem::size_of::<i32>() as u32,
        );
    }
}

/// 0xAARRGGBB，alpha 为 0 即完全透明。
/// 不用 `DWMWA_COLOR_NONE`（0xFFFFFFFE）：实测该值被本机 DWM 拒绝。
const TRANSPARENT_BORDER: u32 = 0x0000_0000;

/// 关掉 Windows 11 的可见窗口边框，并禁用 DWM 过渡动画。
///
/// Win11 默认给每个顶层窗口画一圈细边框（实测 `DWMWA_VISIBLE_FRAME_BORDER_THICKNESS`
/// 为 2px），默认色浅灰，停用态比激活态更浅。透明桌宠不需要它。
///
/// 过渡动画一并禁用：激活状态切换时 DWM 会走一段过渡，中间帧会表现为闪烁。
pub fn disable_window_border(hwnd: HWND) {
    unsafe {
        for attr in [DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR] {
            let _ = DwmSetWindowAttribute(
                hwnd,
                attr,
                &TRANSPARENT_BORDER as *const _ as *const core::ffi::c_void,
                core::mem::size_of::<u32>() as u32,
            );
        }

        let disable: i32 = 1; // TRUE
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disable as *const _ as *const core::ffi::c_void,
            core::mem::size_of::<i32>() as u32,
        );
    }
}

/// 桌面形态：穿透 + 不进任务栏 + 不抢焦点，并**清除** WS_EX_LAYERED
pub fn apply_desktop_style(hwnd: HWND) -> Result<(), WindowError> {
    disable_nonclient_rendering(hwnd);
    disable_window_border(hwnd);

    unsafe {
        // ① 清理普通样式中的边框位（GWL_STYLE）
        let normal = get_style(hwnd, GWL_STYLE)?;
        // 必须显式置 WS_POPUP：只清除边框位而不指定窗口类型，
        // Windows 会回退绘制标题栏（表现为顶部一条白框，带窗口标题文字）。
        let cleaned = (normal & !BORDER_BITS) | WS_POPUP.0;
        let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, cleaned as isize);

        // ② 扩展样式：穿透 + 不进任务栏 + 不抢焦点，并清除 layered 与边框位
        let current = get_style(hwnd, GWL_EXSTYLE)?;

        let style = ((current | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0)
            & !WS_EX_LAYERED.0)
            & !EX_BORDER_BITS;

        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);

        // 样式变更后必须触发一次重排，否则 WebView2 不会重新计算合成区域
        let _ = SetWindowPos(
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

/// 单独控制鼠标穿透位，不影响其他样式。
///
/// 这是钩子的核心动作：宠物窗口默认带 WS_EX_TRANSPARENT（收不到鼠标消息），
/// 钩子判定指针进入宠物区域后，靠这个函数临时取消穿透，使其可交互。
pub fn set_click_through(hwnd: HWND, enable: bool) -> Result<(), WindowError> {
    unsafe {
        let current = get_style(hwnd, GWL_EXSTYLE)?;

        let style = if enable {
            current | WS_EX_TRANSPARENT.0
        } else {
            current & !WS_EX_TRANSPARENT.0
        };

        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);

        // 改扩展样式后必须触发重排，否则 DWM 仍按旧的窗口区域合成
        let _ = SetWindowPos(
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
        let current = get_style(hwnd, GWL_EXSTYLE)?;

        // 清除桌面形态的三个扩展位：子窗口需要正常接收鼠标消息
        let style = current
            & !WS_EX_TRANSPARENT.0
            & !WS_EX_TOOLWINDOW.0
            & !WS_EX_NOACTIVATE.0
            & !WS_EX_LAYERED.0;

        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);

        // 面板形态要变成子窗口：移除 WS_POPUP，置 WS_CHILD。
        // WS_CHILD 属于普通样式位（GWL_STYLE），且必须在 SetParent 之后置位才稳定，
        // 所以这里只管样式位，迁移顺序由 PetWindow 状态机保证。
        let normal = get_style(hwnd, GWL_STYLE)?;
        let cleaned = (normal & !BORDER_BITS & !WS_POPUP.0) | WS_CHILD.0;
        let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, cleaned as isize);
        let _ = SetWindowPos(
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
