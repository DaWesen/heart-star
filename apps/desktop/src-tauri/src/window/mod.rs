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

pub struct PetWindow {
    hwnd: HWND,
    form: Form,
    /// 桌面形态下的最后位置，用于从面板返回时原位恢复
    last_desktop_pos: (i32, i32),
    hook: Option<hook::HookHandle>,
}

// SAFETY: HWND 是 Win32 窗口句柄，可跨线程持有；Win32 窗口 API 本身线程安全。
// 本项目实际只在主线程操作窗口，跨线程仅传递句柄本身。
// 需要这两个 impl 是因为 Tauri 的 State（app.manage）要求 T: Send + Sync + 'static。
unsafe impl Send for PetWindow {}
unsafe impl Sync for PetWindow {}

impl PetWindow {
    pub fn new(hwnd: HWND) -> Self {
        Self {
            hwnd,
            form: Form::Desktop,
            last_desktop_pos: (100, 100),
            hook: None,
        }
    }

    pub fn form(&self) -> Form {
        self.form
    }

    /// 接管窗口：应用桌面形态样式并装上鼠标钩子。
    /// 与 `to_desktop` 的区别——不做宿主迁移，因为窗口本来就没有宿主。
    pub fn init(&mut self) -> Result<(), WindowError> {
        style::apply_desktop_style(self.hwnd)?;
        // 子类化窗口过程：抓住停用瞬间并在原地重绘。
        // 失败同样不致命，只是退化成"横条会闪一下"。
        if proc::install(self.hwnd) {
            eprintln!("[heart-star] 窗口过程已接管");
        } else {
            eprintln!("[heart-star] 警告：窗口过程接管失败");
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
        if host.is_invalid() {
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
            Form::Panel(host) if host.is_invalid() => self.force_desktop(),
            _ => Ok(()),
        }
    }

    fn try_to_panel(&mut self, host: HWND, area: host::Rect) -> Result<(), WindowError> {
        host::hide(self.hwnd);
        style::apply_panel_style(self.hwnd)?;
        host::attach_to(self.hwnd, host)?;
        host::place(self.hwnd, area)?;
        host::show(self.hwnd);

        // 子窗口正常接收鼠标消息，钩子必须卸载，否则重复判定
        if let Some(h) = self.hook.take() {
            hook::uninstall(h);
        }

        // 跨 DPI 迁移后必须重算渲染分辨率
        dpi::sync_renderer_scale(self.hwnd);
        Ok(())
    }

    fn try_to_desktop(&mut self) -> Result<(), WindowError> {
        let (x, y) = self.last_desktop_pos;
        host::hide(self.hwnd);
        host::detach(self.hwnd)?;
        style::apply_desktop_style(self.hwnd)?;
        host::place(
            self.hwnd,
            host::Rect {
                x,
                y,
                ..Default::default()
            },
        )?;
        host::show(self.hwnd);

        // 桌面形态下窗口被穿透，收不到鼠标消息，必须靠全局钩子
        self.hook = Some(hook::install(self.hwnd)?);

        dpi::sync_renderer_scale(self.hwnd);
        Ok(())
    }

    /// 强制回落。不因任何中间步骤失败而中断，尽力把宠物救回桌面。
    fn force_desktop(&mut self) -> Result<(), WindowError> {
        host::hide(self.hwnd);
        let _ = host::detach(self.hwnd);
        let _ = style::apply_desktop_style(self.hwnd);
        host::show(self.hwnd);
        if self.hook.is_none() {
            self.hook = hook::install(self.hwnd).ok();
        }
        self.form = Form::Desktop;
        Ok(())
    }
}
