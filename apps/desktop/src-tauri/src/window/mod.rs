//! 宠物窗口形态管理 —— 整个项目的核心状态机
//!
//! 两条团队纪律（不是建议，是必须）：
//!
//!  1. **所有 Win32 调用仅限 window/ 模块内**，`unsafe` 绝不上溢到业务层。
//!     业务代码里混着裸 Win32 调用，半年后没人敢改。
//!
//!  2. **任何形态切换必须经过 PetWindow 状态机**，禁止业务代码直接调 `SetParent`。
//!     理由：切换是异步且可失败的（面板已销毁、坐标越界、跨 DPI 显示器），
//!     散落的裸调用会让"宠物丢失"这类 bug 无法复现、无法定位。
//!     状态机同时提供兜底：检测到宿主失效就强制回到桌面形态。
//!
//! 切换序列统一为：先隐藏 → 改样式/父窗口 → 再显示。
//! 这一步是规避闪烁与重绘撕裂的关键，不要省略。

pub mod dpi;
pub mod hook;
pub mod host;
pub mod proc;
pub mod style;

use std::fmt;
use windows::Win32::Foundation::HWND;

use crate::logging::{log, log_warn};

/// 宠物窗口形态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// 桌面形态：独立透明窗口，鼠标穿透
    Desktop,
    /// 面板形态：已挂载到面板宿主窗口
    Panel(HWND),
    /// 切换进行中。切换是异步的，此态下拒绝新的切换请求。
    Transitioning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowError {
    /// 宿主窗口已销毁或句柄无效
    InvalidHost,
    /// 样式位修改失败
    StyleFailed,
    /// SetParent 失败
    ParentFailed,
    /// 全局鼠标钩子安装失败
    HookFailed,
    /// 正在切换中，拒绝并发请求
    Busy,
}

impl fmt::Display for WindowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::InvalidHost => "宿主窗口无效",
            Self::StyleFailed => "窗口样式修改失败",
            Self::ParentFailed => "宿主迁移失败",
            Self::HookFailed => "全局鼠标钩子安装失败",
            Self::Busy => "上一次切换尚未完成",
        };
        f.write_str(s)
    }
}

impl std::error::Error for WindowError {}

/// 归一化命中区域（0..1），用于钩子里的粗判。
/// 精确判定交给渲染层（Live2D Drawable / VRM 射线），
/// 钩子里只做廉价计算 —— 它在全局鼠标消息路径上，不能做重活。
#[derive(Debug, Clone, Copy)]
pub struct HitRegion {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// 尚不知道窗口真实尺寸时的兜底矩形（物理像素）。
/// 只在 `init` 之前就发生 `to_desktop` 这种顺序错误时才会用到。
const FALLBACK_RECT: host::Rect = host::Rect {
    x: 100,
    y: 100,
    width: 320,
    height: 420,
};

pub struct PetWindow {
    hwnd: HWND,
    form: Form,
    /// 桌面形态下的最后一个矩形（物理像素），用于从面板返回时原位恢复。
    ///
    /// 必须**连尺寸一起存**：只存 x/y 会让 `SetWindowPos` 收到 0×0，
    /// 宠物从面板回到桌面时直接塌成一个点，且看不出是哪里出的错。
    last_desktop_rect: host::Rect,
    hook: Option<hook::HookHandle>,
}

// SAFETY: HWND 是 Win32 窗口句柄，可跨线程持有；Win32 窗口 API 本身线程安全。
// 本项目实际只在主线程操作窗口，跨线程仅传递句柄本身。
// 需要这两个 impl 是因为 Tauri 的 State（app.manage）要求 T: Send + Sync + 'static。
unsafe impl Send for PetWindow {}
unsafe impl Sync for PetWindow {}

impl PetWindow {
    pub fn new(hwnd: HWND) -> Self {
        // 趁窗口还存在就把初始矩形读下来。等到 `to_desktop` 时窗口可能已经
        // 挂在面板里，那时读到的就不是桌面坐标了。
        let initial = host::current_rect(hwnd);
        let degenerate = initial.width <= 0 || initial.height <= 0;

        Self {
            hwnd,
            form: Form::Desktop,
            last_desktop_rect: if degenerate { FALLBACK_RECT } else { initial },
            hook: None,
        }
    }

    pub fn form(&self) -> Form {
        self.form
    }

    /// 宠物窗口句柄。宿主探针等外部代码需要它才能发起迁移。
    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// 窗口当前所在显示器的缩放系数（1.0 = 100%）。
    ///
    /// 每次现算而不缓存：跨屏后缓存值就是脏的，而查询成本只是一次 `GetDpiForWindow`。
    pub fn renderer_scale(&self) -> f64 {
        dpi::scale_for(self.hwnd)
    }

    /// 接管窗口：应用桌面形态样式并装上鼠标钩子。
    /// 与 `to_desktop` 的区别——不做宿主迁移，因为窗口本来就没有宿主。
    pub fn init(&mut self) -> Result<(), WindowError> {
        style::apply_desktop_style(self.hwnd)?;
        // 子类化窗口过程：抓住停用瞬间并在原地重绘。
        // 失败同样不致命，只是退化成"横条会闪一下"。
        if proc::install(self.hwnd) {
            log!("窗口过程已接管");
        } else {
            log_warn!("窗口过程接管失败");
        }
        // 钩子失败不致命：退化为"始终穿透"，宠物仍可见只是不可交互。
        // 若在此返回 Err，一个钩子问题就会让宠物彻底不显示，代价不成比例。
        self.hook = hook::install(self.hwnd).ok();
        self.form = Form::Desktop;
        Ok(())
    }

    /// 钩子是否安装成功 —— 供主进程诊断输出。
    /// 钩子失败不应阻止宠物显示，但必须能被看见，否则会变成"宠物在但点不动"的疑难问题。
    pub fn hook_installed(&self) -> bool {
        self.hook.is_some()
    }

    /// 切换到面板形态。
    /// 顺序：隐藏 → 改样式（去穿透、加 WS_CHILD）→ SetParent → 重排 → 显示 → 卸钩子。
    pub fn to_panel(&mut self, host: HWND, area: host::Rect) -> Result<(), WindowError> {
        if self.form == Form::Transitioning {
            return Err(WindowError::Busy);
        }
        // 与 ensure_valid 用同一个判定：句柄非空不等于窗口还在，
        // 只看 is_invalid() 会漏掉"宿主已关闭"这种情况。
        if !host::is_alive(host) {
            return Err(WindowError::InvalidHost);
        }

        self.form = Form::Transitioning;
        let result = self.try_to_panel(host, area);

        match result {
            Ok(()) => self.form = Form::Panel(host),
            Err(_) => {
                // 切换失败必须回落到桌面形态，绝不允许卡在 Transitioning
                let _ = self.force_desktop();
            }
        }
        result
    }

    /// 切换到桌面形态。
    /// 顺序：隐藏 → SetParent(NULL) → 恢复穿透样式 → 定位 → 显示 → 装钩子。
    pub fn to_desktop(&mut self) -> Result<(), WindowError> {
        if self.form == Form::Transitioning {
            return Err(WindowError::Busy);
        }
        self.form = Form::Transitioning;
        let result = self.try_to_desktop();
        match result {
            Ok(()) => self.form = Form::Desktop,
            Err(_) => {
                let _ = self.force_desktop();
            }
        }
        result
    }

    /// 兜底：检测宿主是否仍有效，失效则强制回桌面形态。
    /// 由主循环低频轮询 + 面板退出事件共同触发。
    pub fn ensure_valid(&mut self) -> Result<(), WindowError> {
        match self.form {
            // 两个判定缺一不可：
            //   is_alive   —— 宿主被销毁。句柄值此时依然非空，只判空会漏掉。
            //   is_visible —— 宿主被隐藏。面板是"隐藏而非销毁"的，
            //                 宠物挂在隐藏窗口上等于跟着一起消失，必须拉回桌面。
            Form::Panel(host) if !host::is_alive(host) || !host::is_visible(host) => {
                self.force_desktop()
            }
            _ => Ok(()),
        }
    }

    fn try_to_panel(&mut self, host: HWND, area: host::Rect) -> Result<(), WindowError> {
        // 先记下当前矩形再搬走。以前这里用的是硬编码初值，
        // 从面板返回桌面时宠物会跳回屏幕左上角。
        let current = host::current_rect(self.hwnd);
        if current.width > 0 && current.height > 0 {
            self.last_desktop_rect = current;
        }

        host::hide(self.hwnd);
        style::apply_panel_style(self.hwnd)?;
        host::attach_to(self.hwnd, host)?;
        host::place(self.hwnd, area)?;
        // 必须在显示之前提层，否则可能被面板的 WebView2 盖住
        host::raise(self.hwnd);
        host::show(self.hwnd);

        // 子窗口正常接收鼠标消息，钩子必须卸载，否则重复判定
        if let Some(h) = self.hook.take() {
            hook::uninstall(h);
        }
        Ok(())
    }

    fn try_to_desktop(&mut self) -> Result<(), WindowError> {
        host::hide(self.hwnd);
        host::detach(self.hwnd)?;
        style::apply_desktop_style(self.hwnd)?;
        // 用完整的最后一个矩形，而不是只还原 x/y
        host::place(self.hwnd, self.last_desktop_rect)?;
        host::show(self.hwnd);

        // 桌面形态下窗口被穿透，收不到鼠标消息，必须靠全局钩子
        self.hook = Some(hook::install(self.hwnd)?);
        Ok(())
    }

    /// 强制回落。不因任何中间步骤失败而中断，尽力把宠物救回桌面。
    fn force_desktop(&mut self) -> Result<(), WindowError> {
        host::hide(self.hwnd);
        let _ = host::detach(self.hwnd);
        let _ = style::apply_desktop_style(self.hwnd);
        // 宿主没了的时候宠物还是个子窗口，坐标是宿主客户区坐标。
        // 不摆回桌面矩形，它可能停在屏幕外——那和"宠物消失"没区别。
        let _ = host::place(self.hwnd, self.last_desktop_rect);
        host::show(self.hwnd);
        if self.hook.is_none() {
            self.hook = hook::install(self.hwnd).ok();
        }
        self.form = Form::Desktop;
        Ok(())
    }
}
