//! IPC：壳 ↔ 面板
//!
//! 面板**不直接**对渲染层发命令：渲染层只认壳这一个命令来源。多一个来源
//! 就要多维护一套"谁有权改角色/窗口"的规则，而壳本来就是唯一权威，
//! 让它当中转是零成本的。
//!
//! 这里还承担一件两边都做不了的事：**扫描角色目录**。
//! 渲染层与面板都拿不到文件系统，只有壳能读 `assets/characters/`。

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewWindow};

use super::generated::{
    CharacterKind, CharacterSummary, PanelCommand, PanelEvent, CHANNEL_PANEL_COMMAND,
    CHANNEL_PANEL_EVENT,
};
use super::{send, ShellCommand, PET_LABEL};
use crate::lifecycle::{auto_launch_enabled, set_auto_launch};
use crate::logging::{log, log_warn};

/// 壳 → 面板：下发一条命令。全局广播 —— 面板可能还没建出来，那时自然无人接收。
pub fn send_panel(app: &AppHandle, cmd: &PanelCommand) -> Result<(), tauri::Error> {
    app.emit(CHANNEL_PANEL_COMMAND, cmd)
}

/// 面板 → 壳：注册监听。
///
/// 用**窗口级**监听而不是 `app.listen`，与渲染层 `ipc::bind` 保持一致：
/// 面板页面用全局 `emit` 发事件，窗口级监听能收到；反过来若页面改走
/// `emitTo`，窗口级监听同样能收到，而 `app.listen` 收不到。
pub fn bind(panel: &WebviewWindow) {
    let w = panel.clone();
    panel.listen(
        CHANNEL_PANEL_EVENT,
        move |event| match serde_json::from_str::<PanelEvent>(event.payload()) {
            Ok(evt) => handle_event(w.app_handle(), evt),
            Err(e) => log_warn!("面板事件解析失败: {e}"),
        },
    );
}

/// 下发角色列表。
///
/// 除了面板自己喊 ready 时发一次，**每次显示面板也发一次**：
/// 面板页面可能被 vite HMR 重载，重载后它那份列表就没了。
/// 只在 ready 时发一次的话，热重载之后按钮会凭空消失。
pub fn send_character_list(app: &AppHandle) {
    let characters = scan_characters();
    log!("角色列表：{} 个", characters.len());
    if let Err(e) = send_panel(app, &PanelCommand::CharacterList { characters }) {
        log_warn!("角色列表下发失败: {e}");
    }
}

fn handle_event(app: &AppHandle, evt: PanelEvent) {
    match evt {
        PanelEvent::Ready => {
            log!("面板已就绪");
            send_character_list(app);
            send_autostart_state(app);
        }
        PanelEvent::SwitchCharacter { character_id } => {
            let Some(pet) = app.get_webview_window(PET_LABEL) else {
                log_warn!("宠物窗口不存在，忽略切换请求");
                return;
            };
            let cmd = ShellCommand::SwitchCharacter { character_id };
            if let Err(e) = send(&pet, &cmd) {
                log_warn!("切换角色下发失败: {e}");
            }
        }
        PanelEvent::SetCharacterScale { scale } => {
            let Some(pet) = app.get_webview_window(PET_LABEL) else {
                log_warn!("宠物窗口不存在，忽略缩放请求");
                return;
            };
            let cmd = ShellCommand::SetCharacterScale { scale };
            if let Err(e) = send(&pet, &cmd) {
                log_warn!("缩放下发失败: {e}");
            }
        }
        PanelEvent::SetAutostart { enabled } => {
            // 开机自启没有窗口、没有任务栏入口，开关成没成肉眼看不见，
            // 所以这条链路必须留痕 —— 否则"设了但没生效"无从查起
            log!("开机自启 -> {}", if enabled { "开" } else { "关" });
            if let Err(e) = set_auto_launch(enabled) {
                log_warn!("开机自启设置失败: {e}");
            }
            // 下发的不是用户刚输入的值，而是写完后**回读**的结果：
            // 写失败时面板上的勾选框会被拨回去，用户看到的始终是真实状态
            send_autostart_state(app);
        }
    }
}

/// 下发开机自启状态。
///
/// 与角色列表同一个调用时机：面板就绪时一次、每次显示面板再一次。
/// 少任何一次，HMR 重载后勾选框就会停在错误的初始值上。
pub fn send_autostart_state(app: &AppHandle) {
    let enabled = auto_launch_enabled();
    if let Err(e) = send_panel(app, &PanelCommand::AutostartChanged { enabled }) {
        log_warn!("开机自启状态下发失败: {e}");
    }
}

/// 角色包根目录。
///
/// 开发期用编译期路径定位。发布时角色包要随安装包分发（走 Tauri 的 resource
/// 机制），届时这里要改成 `app.path().resource_dir()` —— 那属于
/// M3「角色包从外部加载」，现在先不引。
fn characters_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../assets/characters")
}

/// 扫出所有可切换的角色。
///
/// 只读 manifest 里的三个字段：**不解析整个 manifest**。
/// 完整 manifest 由渲染层自己加载 —— 它要拿 semantics / motions 去接 adapter，
/// 壳并不需要知道这些。在这里把整份结构解析进来只会让两侧耦合。
fn scan_characters() -> Vec<CharacterSummary> {
    let root = characters_root();
    let Ok(entries) = fs::read_dir(&root) else {
        log_warn!("角色目录不可读：{}", root.display());
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path().join("manifest.json");
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        // 容忍 UTF-8 BOM：美术常在 Windows 记事本里改 manifest，带 BOM 会让
        // serde_json 直接报 "expected value"。与 character-schema 的 CLI 同一策略。
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            log_warn!("manifest 解析失败，跳过：{}", path.display());
            continue;
        };

        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(kind) = value
            .get("kind")
            .and_then(Value::as_str)
            .and_then(parse_kind)
        else {
            log_warn!("角色 {} 的 kind 无法识别，跳过", id);
            continue;
        };
        let display_name = value
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();

        found.push(CharacterSummary {
            id: id.to_string(),
            display_name,
            kind,
        });
    }

    // 按 id 排序：read_dir 的顺序在不同文件系统上不一致，
    // 不排序的话面板上的按钮顺序会随机变化
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

/// 复用生成的 serde 定义来解析 kind，不手写第二份字符串映射。
fn parse_kind(raw: &str) -> Option<CharacterKind> {
    serde_json::from_value::<CharacterKind>(Value::String(raw.to_string())).ok()
}
