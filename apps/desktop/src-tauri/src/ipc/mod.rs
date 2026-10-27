//! IPC：壳 ↔ 渲染
//!
//! 消息结构全部由 `packages/protocol` 生成（见 `generated.rs`），**禁止手写镜像**。
//! 通道名同样来自协议包，两侧共用同一份常量。
//!
//! 为什么两侧都用事件而不用 `invoke`：本阶段所有消息都是**单向**的，
//! 没有请求/响应语义。用 invoke 就得额外维护一套命令权限与错误通道，
//! 却换不来任何东西。等 M4 需要 AI 流式响应时再引 `tauri::ipc::Channel`。

pub mod generated;
pub mod panel;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Listener, Manager, WebviewWindow};

use crate::logging::{log, log_warn};
use crate::window::{self, hook};

pub use generated::{
    FrameBudget, InputMode, PanelCommand, PetForm, RendererCapabilities, RendererEvent,
    SemanticArea, ShellCommand, CHANNEL_RENDERER_EVENT, CHANNEL_SHELL_COMMAND,
};

/// 帧预算档位。桌宠绝大多数时间处于空闲，呼吸这类慢动作 15fps 完全够用，
/// 按 60fps 空转只是在烧用户的电。
/// 宠物窗口 / 面板窗口的 label。
/// 散落的字符串字面量拼错时不会报错，只会"静默找不到窗口"，所以收成常量。
pub const PET_LABEL: &str = "pet";
pub const PANEL_LABEL: &str = "panel";

pub const ACTIVE_FPS: f64 = 60.0;
pub const IDLE_FPS: f64 = 15.0;

/// 无交互多久算空闲。钩子只在指针**进入**宠物区域时打时间戳，
/// 悬停期间的持续移动不刷新 —— 否则"盯着宠物看"会被误判成一直活跃。
pub const IDLE_AFTER_SECS: u64 = 30;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 壳 → 渲染：下发一条命令。
pub fn send(window: &WebviewWindow, cmd: &ShellCommand) -> Result<(), tauri::Error> {
    window.emit(CHANNEL_SHELL_COMMAND, cmd)
}

/// 渲染 → 壳：注册监听。
///
/// 必须在窗口创建后、页面加载完成前注册。页面 `ready` 之前的消息会丢失，
/// 所以初始状态一律放在收到 `ready` 之后的握手里补发，而不是这里直接发。
pub fn bind(window: &WebviewWindow) {
    let w = window.clone();
    window.listen(
        CHANNEL_RENDERER_EVENT,
        move |event| match serde_json::from_str::<RendererEvent>(event.payload()) {
            Ok(evt) => handle(&w, evt),
            Err(e) => log_warn!("渲染事件解析失败: {e}"),
        },
    );
}

fn handle(window: &WebviewWindow, evt: RendererEvent) {
    match evt {
        RendererEvent::CharacterSwitched { character_id } => {
            log!("角色已切换：{character_id}");
            // 面板要据此更新"当前角色"高亮，否则点了按钮看不出有没有生效
            let app = window.app_handle();
            if let Err(e) =
                panel::send_panel(app, &PanelCommand::CharacterSwitched { character_id })
            {
                log_warn!("切换结果下发面板失败: {e}");
            }
        }
        RendererEvent::CharacterScaled {
            character_id,
            scale,
        } => {
            let app = window.app_handle();
            if let Err(e) = panel::send_panel(
                app,
                &PanelCommand::CharacterScaled {
                    character_id,
                    scale,
                },
            ) {
                log_warn!("缩放结果下发面板失败: {e}");
            }
        }
        RendererEvent::Ready { capabilities } => {
            log!(
                "渲染层就绪 | ik={} 加性层={} 物理={}",
                capabilities.ik,
                capabilities.additive_layer,
                capabilities.physics
            );
            handshake(window);
        }
        // M2：命中结果决定"摸头/摸手"反馈，壳层暂不需要
        RendererEvent::HitTest { .. } => {}
        RendererEvent::FrameStats { fps, frame_ms } => {
            log!("渲染 {fps:.1}fps / {frame_ms:.2}ms");
        }
        RendererEvent::Error { message, fatal } => {
            log!("渲染层错误（fatal={fatal}）: {message}");
            // 转发给面板：角色切换失败这类原因，用户只能从面板上看到。
            // 渲染层自己是没有 UI 的透明窗口。
            let app = window.app_handle();
            let _ = panel::send_panel(app, &PanelCommand::CharacterFailed { message });
        }
    }
}

/// 渲染层就绪后补发初始状态。
///
/// 为什么不在 `bind` 里直接发：页面 `ready` 之前的消息会全部丢失，
/// 初始状态只能等对方喊准备好了再补。
///
/// 刻意**不发帧预算**：那是 `spawn_frame_budget_governor` 独占的职责。
/// 两边都首发的話会连打两条一样的日志，且各自维护一份"已下发到哪一档"的状态，
/// 迟早互相打架。监管线程 1 秒内就会发第一档，这个间隔无感。
fn handshake(window: &WebviewWindow) {
    announce(window, PetForm::Desktop);
}

/// 窗口当前的 CSS 像素尺寸。
///
/// 必须下发 **CSS 像素**而不是物理像素：`inner_size()` 是物理值，
/// 渲染层拿到 480×630 会以为自己有那么大，于是在 150% 缩放下按错误的分辨率布局。
fn css_size(window: &WebviewWindow) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 {
        return None;
    }
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// 把壳侧的形态翻译成协议形态。
///
/// 切换进行中返回 `None`：那一刻形态未定，下发任何一个值都可能是错的，
/// 而渲染层会照着它改合成方式。宁可这条不发，等下一轮稳定了再发。
pub fn to_protocol(form: window::Form) -> Option<PetForm> {
    match form {
        window::Form::Desktop => Some(PetForm::Desktop),
        window::Form::Panel(host) => Some(PetForm::Panel {
            // 句柄过 JSON 只能是双精度。Windows 的 HWND 值远小于 2^53，不会丢精度。
            host_handle: host.0 as isize as f64,
        }),
        window::Form::Transitioning => None,
    }
}

/// 下发当前形态与尺寸。
///
/// 形态切换、跨屏 DPI 变化之后都必须重发一次：渲染层拿不到 HWND，
/// 既读不到自己窗口的物理尺寸，也感知不到自己被搬进了面板 —— 它是靠这条
/// 消息才知道该按多大画布布局的。漏掉它，表现是"宠物进了面板但画在错误的位置"。
pub fn announce(window: &WebviewWindow, form: PetForm) {
    if let Some((width, height)) = css_size(window) {
        let bounds = ShellCommand::SetBounds {
            x: 0.0,
            y: 0.0,
            width,
            height,
        };
        if let Err(e) = send(window, &bounds) {
            log_warn!("尺寸下发失败: {e}");
        }
    }

    if let Err(e) = send(window, &ShellCommand::SetForm { form }) {
        log_warn!("形态下发失败: {e}");
    }
}

/// 下发帧预算，并打印一次。
///
/// 保留这行日志的理由：帧预算是"用户会不会在任务管理器里看到我们在烧 CPU"
/// 的唯一开关，而降帧失效的表现非常隐蔽（帧率对不上但画面看着正常）。
/// 每秒最多一行，只在档位变化时打，开销可忽略。
pub fn set_frame_budget(window: &WebviewWindow, budget: FrameBudget) {
    let label = match &budget {
        FrameBudget::Fps { value } => format!("{value}fps"),
        FrameBudget::Paused => "暂停".to_string(),
    };
    if let Err(e) = send(window, &ShellCommand::SetFrameBudget { budget }) {
        log_warn!("帧预算下发失败: {e}");
        return;
    }
    log!("帧预算 -> {label}");
}

/// 帧预算策略：空闲一段时间后降帧，有交互立刻恢复。
///
/// 单独起低频线程轮询而不是挂在鼠标钩子上：钩子位于全局鼠标消息路径上，
/// 在里面做任何重活都会拖慢整个系统的鼠标响应。这里每秒一次，开销可忽略。
pub fn spawn_frame_budget_governor(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut sent: Option<f64> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));

            let idle_for = now_secs().saturating_sub(hook::last_interaction_secs());
            let want = if idle_for >= IDLE_AFTER_SECS {
                IDLE_FPS
            } else {
                ACTIVE_FPS
            };

            if sent == Some(want) {
                continue;
            }
            set_frame_budget(&window, FrameBudget::Fps { value: want });
            sent = Some(want);
        }
    });
}
