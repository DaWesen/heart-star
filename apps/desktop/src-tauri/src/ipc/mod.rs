//! IPC：壳 ↔ 渲染
//!
//! 消息结构全部由 `packages/protocol` 生成（见 `generated.rs`），**禁止手写镜像**。
//! 通道名同样来自协议包，两侧共用同一份常量。
//!
//! 为什么两侧都用事件而不用 `invoke`：本阶段所有消息都是**单向**的，
//! 没有请求/响应语义。用 invoke 就得额外维护一套命令权限与错误通道，
//! 却换不来任何东西。等 M4 需要 AI 流式响应时再引 `tauri::ipc::Channel`。

pub mod generated;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Listener, WebviewWindow};

use crate::window::hook;

pub use generated::{
    FrameBudget, InputMode, PetForm, RendererCapabilities, RendererEvent, SemanticArea,
    ShellCommand, CHANNEL_RENDERER_EVENT, CHANNEL_SHELL_COMMAND,
};

/// 帧预算档位。桌宠绝大多数时间处于空闲，呼吸这类慢动作 15fps 完全够用，
/// 按 60fps 空转只是在烧用户的电。
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
            Err(e) => eprintln!("[heart-star] 渲染事件解析失败: {e}"),
        },
    );
}

fn handle(window: &WebviewWindow, evt: RendererEvent) {
    match evt {
        RendererEvent::Ready { capabilities } => {
            eprintln!(
                "[heart-star] 渲染层就绪 | ik={} 加性层={} 物理={}",
                capabilities.ik, capabilities.additive_layer, capabilities.physics
            );
            handshake(window);
        }
        RendererEvent::HitTest { area } => {
            // M2：命中结果决定"摸头/摸手"反馈，壳层暂不需要
            let _ = area;
        }
        RendererEvent::FrameStats { fps, frame_ms } => {
            eprintln!("[heart-star] 渲染 {fps:.1}fps / {frame_ms:.2}ms");
        }
        RendererEvent::Error { message, fatal } => {
            eprintln!("[heart-star] 渲染层错误（fatal={fatal}）: {message}");
        }
    }
}

/// 渲染层就绪后补发初始状态。
///
/// 尺寸下发的是 **CSS 像素**而不是物理像素：`GetWindowRect` 与
/// `inner_size()` 都是物理值，渲染层拿到 480×630 会以为自己有那么大，
/// 于是按错误的分辨率布局。必须除以缩放系数。
fn handshake(window: &WebviewWindow) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);

    for cmd in [
        ShellCommand::SetBounds {
            x: 0.0,
            y: 0.0,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        },
        ShellCommand::SetForm {
            form: PetForm::Desktop,
        },
    ] {
        if let Err(e) = send(window, &cmd) {
            eprintln!("[heart-star] 握手命令下发失败: {e}");
        }
    }

    set_frame_budget(window, FrameBudget::Fps { value: ACTIVE_FPS });
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
        eprintln!("[heart-star] 帧预算下发失败: {e}");
        return;
    }
    eprintln!("[heart-star] 帧预算 -> {label}");
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
