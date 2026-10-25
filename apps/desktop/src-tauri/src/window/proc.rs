//! 窗口过程子类化
//!
//! 无边框透明窗口必须接管窗口过程，否则 `DefWindowProc` 会在两个时机画出不该有的东西：
//!
//!  1. `WM_NCACTIVATE` —— 窗口停用时，`DefWindowProc` 按"停用态"重画一遍非客户区，
//!     表现为**顶部浮出一条浅色横条**。这是本项目踩过的最难定位的一个坑：
//!     样式位、非客户区尺寸、子窗口层次、背景画刷、穿透位全都排查过，都不是它。
//!     根因只有靠拦截这条消息才能解决：不转发，直接返回 TRUE
//!     （告诉系统"继续按激活态绘制"）。窗口的真实激活状态由系统管理，不受返回值影响。
//!
//!  2. `WM_NCPAINT` —— 无边框窗口不该绘制任何非客户区，吞掉。
//!
//!  3. `WM_ERASEBKGND` —— 返回 1 禁止背景擦除。透明窗口一旦被擦成不透明底色就会露出白块。
//!     这比改 `GCLP_HBRBACKGROUND` 直接，后者实测无效。
//!
//! 未拦截的消息一律转发给原窗口过程，绝不吞掉不认识的消息。

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, WM_ERASEBKGND, WM_NCACTIVATE,
    WM_NCPAINT, WNDPROC,
};

/// 原窗口过程。窗口过程可能被重入，所以只保存函数指针本身（fn 指针天然 Sync），
/// 且**取值后立即释放锁**再调用 —— 绝不能持锁调用，否则嵌套消息会死锁。
static PREV_PROC: std::sync::Mutex<Option<WNDPROC>> = std::sync::Mutex::new(None);

extern "system" fn pet_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // 关键：不转发。转发给 DefWindowProc 就会按停用态重画非客户区，
    // 那条顶部横条就是这么来的。
    if msg == WM_NCACTIVATE {
        return LRESULT(1);
    }

    if msg == WM_NCPAINT {
        return LRESULT(0);
    }

    if msg == WM_ERASEBKGND {
        return LRESULT(1);
    }

    let prev = PREV_PROC.lock().ok().and_then(|g| *g);

    match prev {
        Some(p) => unsafe { CallWindowProcW(p, hwnd, msg, wparam, lparam) },
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 接管窗口过程。返回 false 表示失败（调用方退化为不拦截）。
pub fn install(hwnd: HWND) -> bool {
    unsafe {
        // 先转 fn 指针再取地址：直接对函数项做整数转换会触发 `direct cast of function item` 警告
        let proc_fn: WNDPROC = Some(pet_proc);
        let addr = proc_fn.map(|f| f as usize).unwrap_or_default();

        let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, addr as isize);
        if prev == 0 {
            return false;
        }

        // SAFETY: prev 就是本窗口原先的 WNDPROC 指针，由 SetWindowLongPtrW 原样返回。
        // isize 与 Option<fn> 同为指针宽度，这里只是把整数还原成函数指针。
        let prev_fn: WNDPROC = std::mem::transmute(prev);
        if let Ok(mut guard) = PREV_PROC.lock() {
            *guard = Some(prev_fn);
        }
        true
    }
}
