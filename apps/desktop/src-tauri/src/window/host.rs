//! 宿主迁移：SetParent
//!
//! 单次形态切换的固定序列（顺序不可调换）：
//!   hide → 改样式 → SetParent → SetWindowPos → show
//! 先隐藏再显示，规避绝大部分闪烁与重绘撕裂。
//!
//! 注意 windows 0.62 的约定：`SetParent` 第二参数是 `Option<HWND>`，
//! 挂载传 `Some(host)`，脱离传 `None`。返回值为原父窗口句柄（可能为 NULL）。
//! （0.58 时代是泛型 `Param<HWND>` 且不接受 Option —— 升级时需重新核对签名。）

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, IsWindow, IsWindowVisible, SetParent, SetWindowPos, ShowWindow,
    HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
    SW_SHOWNA,
};

use super::WindowError;

/// 窗口是否仍然存在。
///
/// 不能用 `HWND::is_invalid()` —— 那只判断句柄是否为 NULL，
/// 而"宿主被关闭"之后句柄值依然非空。必须用 `IsWindow` 才能真正检测出来，
/// 否则宿有关闭后状态机会一直以为还在面板形态，宠物就再也叫不回来了。
pub fn is_alive(hwnd: HWND) -> bool {
    unsafe { IsWindow(Some(hwnd)).as_bool() }
}

/// 窗口当前是否可见。
///
/// 面板是**隐藏而非销毁**的（销毁后重建要重新初始化 WebView2，代价太大），
/// 所以"宿主没了"和"宿主被关了"是两件事，必须分开判：
/// 前者靠 `is_alive`，后者靠这里。只看存活的话，宠物会挂在隐藏的面板里跟着一起消失。
pub fn is_visible(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd).as_bool() }
}

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

/// 窗口当前矩形（屏幕物理坐标）。
pub fn current_rect(hwnd: HWND) -> Rect {
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut r).is_err() {
            return Rect::default();
        }
    }
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// 宿主客户区尺寸（物理像素）。
pub fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut r = RECT::default();
    unsafe {
        if GetClientRect(hwnd, &mut r).is_err() {
            return (0, 0);
        }
    }
    (r.right - r.left, r.bottom - r.top)
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

/// 把宠物提到宿主子窗口的最上层。
///
/// 面板的 WebView2 本身也是宿主的子窗口。宠物若排在它下面就会被整块盖住，
/// 表现为"进了面板但宠物不见了"—— 而窗口其实还在，只是被背景层遮着，
/// 这种 bug 从日志上完全看不出来。`SetParent` 不承诺子窗口的 Z 序，必须显式提一次。
///
/// 只在**面板形态**下调用：桌面形态下宠物是顶层窗口，用 HWND_TOP 会清掉置顶属性。
pub fn raise(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
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
