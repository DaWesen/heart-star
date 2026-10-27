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

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Listener, Manager, WebviewWindow};

use crate::logging::{log, log_warn};
use crate::settings::FrameProfile;
use crate::window::{self, hook};

pub use generated::{
    FrameBudget, InputMode, PanelCommand, PetForm, RendererCapabilities, RendererEvent,
    SemanticArea, ShellCommand, CHANNEL_RENDERER_EVENT, CHANNEL_SHELL_COMMAND,
};

/// 宠物窗口 / 面板窗口的 label。
/// 散落的字符串字面量拼错时不会报错，只会"静默找不到窗口"，所以收成常量。
pub const PET_LABEL: &str = "pet";
pub const PANEL_LABEL: &str = "panel";

/// 无交互多久算空闲。钩子只在指针**进入**宠物区域时打时间戳，
/// 悬停期间的持续移动不刷新 —— 否则"盯着宠物看"会被误判成一直活跃。
///
/// 降帧的理由：桌宠绝大多数时间处于空闲，呼吸这类慢动作很低帧率就够，
/// 按满帧空转只是在烧用户的电。具体降到多少、活跃时跑多少，
/// 由用户在面板里定，见 `settings::FrameProfile`。
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
        RendererEvent::HitTest { area } => {
            // 反馈本身由渲染层播（它才知道动作组），壳层只留痕。
            //
            // 必须留这条：命中反馈失效的表现是"点了没反应" ——
            // 不报错、画面不变，没有这一行就分不清是"点击没送到"
            // 还是"送到了但没命中"，而这两者的排查方向完全相反。
            match area {
                Some(a) => log!("点击命中 -> {a:?}"),
                None => log!("点击未命中"),
            }
        }
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
///
/// 两个档位从 `profile` 里逐秒重读而不是启动时读一次：
/// 用户在面板里改了之后，下一秒内就该生效 —— 等到下次重启才生效的
/// 设置会被当成"改了没用"。
pub fn spawn_frame_budget_governor(window: WebviewWindow, profile: Arc<Mutex<FrameProfile>>) {
    std::thread::spawn(move || {
        let mut sent: Option<f64> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));

            let (active, idle) = match profile.lock() {
                Ok(p) => (p.active_fps, p.idle_fps),
                // 锁中毒说明有别的线程在改档位时 panic 了，那一份数据不可信 ——
                // 退回默认档继续跑，总比停在某个未知帧率上强
                Err(e) => {
                    log_warn!("帧率档位读取失败，本轮用默认档: {e}");
                    let d = FrameProfile::default_profile();
                    (d.active_fps, d.idle_fps)
                }
            };

            let idle_for = now_secs().saturating_sub(hook::last_interaction_secs());
            let want = if idle_for >= IDLE_AFTER_SECS {
                idle
            } else {
                active
            };

            if sent == Some(want) {
                continue;
            }
            set_frame_budget(&window, FrameBudget::Fps { value: want });
            sent = Some(want);
        }
    });
}

/// 视线跟随的刷新间隔（~30Hz）。
///
/// 指针每秒能产生上百条消息，逐条转发等于把鼠标消息洪流灌进 IPC。
/// 30Hz 已经超过眼睛能察觉的更新速度，再快的差别用户也看不出来。
const GAZE_INTERVAL_MS: u64 = 33;

/// 指针离窗口中心多远时视线打满 —— 单位是"宠物窗口的尺寸"。
///
/// 1.5 是手感值：指针在宠物自己身上时只有 1/3 不到的偏转（像是"余光注意到"），
/// 挪开一两个身位才看满。取更小的值（比如半个身位）会让视线几乎恒定打满 ——
/// 宠物永远斜眼盯着屏幕边缘，那不是跟随，是抽筋。
const GAZE_FULL_DEFLECTION: f64 = 1.5;

/// 小于这个变化就不下发。指针微动不该产生 IPC。
const GAZE_EPSILON: f64 = 0.01;

/// 视线跟随：把指针位置换算成 -1..1 的视线方向下发给渲染层。
///
/// 同样走独立线程而不是钩子回调（理由见帧预算策略）：钩子在全局鼠标
/// 消息路径上，里面只许留两个原子写。
pub fn spawn_gaze_pump(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut sent: Option<(f64, f64)> = None;
        // 只在"有没有指针来源"翻转时打日志：视线不动的表现很隐蔽，
        // 而逐帧打日志本身就会成为性能问题
        let mut tracking = None;

        loop {
            std::thread::sleep(Duration::from_millis(GAZE_INTERVAL_MS));

            let want = match hook::cursor() {
                Some((x, y)) => match gaze_from_cursor(&window, x, y) {
                    Some(value) => value,
                    None => continue,
                },
                // 钩子未安装（面板形态）：没有指针来源，视线归正
                None => (0.0, 0.0),
            };

            let has_source = hook::cursor().is_some();
            if tracking != Some(has_source) {
                log!(
                    "视线跟随 -> {}",
                    if has_source {
                        "开（桌面形态）"
                    } else {
                        "暂停（面板形态无指针来源）"
                    }
                );
                tracking = Some(has_source);
            }

            if sent.is_some_and(|(px, py)| {
                (px - want.0).abs() < GAZE_EPSILON && (py - want.1).abs() < GAZE_EPSILON
            }) {
                continue;
            }

            if let Err(e) = send(
                &window,
                &ShellCommand::SetGazeTarget {
                    nx: want.0,
                    ny: want.1,
                },
            ) {
                log_warn!("视线下发失败: {e}");
                continue;
            }
            sent = Some(want);
        }
    });
}

/// 点击转发：把钩子记下的按下位置换算成客户区 CSS 坐标下发给渲染层。
///
/// 阻塞在 channel 上而不是轮询 —— 点击是稀疏事件，
/// 为它定时唤醒线程既没意义又会白白占用一个 CPU 时间片。
pub fn spawn_tap_pump(window: WebviewWindow) {
    let rx = hook::take_tap_receiver();
    std::thread::spawn(move || {
        for (x, y) in rx {
            match css_point(&window, x, y) {
                Some((cx, cy)) => {
                    if let Err(e) = send(&window, &ShellCommand::Tap { x: cx, y: cy }) {
                        log_warn!("点击下发失败: {e}");
                    }
                }
                // 拿不到窗口几何（窗口刚创建/被藏起）时丢掉这次点击：
                // 补发一个"过期的点击"只会让宠物在错误的位置上作出反应
                None => log_warn!("点击坐标换算失败，本次忽略"),
            }
        }
    });
}

/// 屏幕物理像素 → 宠物窗口客户区的 CSS 像素。
fn css_point(window: &WebviewWindow, x: i32, y: i32) -> Option<(f64, f64)> {
    let pos = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    if scale <= 0.0 {
        return None;
    }
    // outer_position 给的是物理像素，渲染层要的是 CSS 像素：
    // 差一个 DPI 倍率的话，点的位置在 150% 缩放下会整体偏出去
    Some(((x - pos.x) as f64 / scale, (y - pos.y) as f64 / scale))
}

/// 指针（屏幕物理像素）相对宠物窗口中心的方向，归一化到 -1..1。
fn gaze_from_cursor(window: &WebviewWindow, x: i32, y: i32) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?;
    let pos = window.outer_position().ok()?;
    // 尺寸为 0（窗口刚创建/被藏起来）时下发的会是 NaN 或无穷，
    // 那会一路污染到模型的参数里
    if size.width == 0 || size.height == 0 {
        return None;
    }

    let cx = pos.x as f64 + size.width as f64 / 2.0;
    let cy = pos.y as f64 + size.height as f64 / 2.0;
    let nx = ((x as f64 - cx) / (size.width as f64 * GAZE_FULL_DEFLECTION)).clamp(-1.0, 1.0);
    let ny = ((y as f64 - cy) / (size.height as f64 * GAZE_FULL_DEFLECTION)).clamp(-1.0, 1.0);
    Some((nx, ny))
}
