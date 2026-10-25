//! 由 packages/protocol 生成 —— **请勿手改**
//!
//! 修改消息结构请改 packages/protocol/src/index.ts，然后执行：
//!   pnpm --filter @heart-star/protocol gen:rust
//!
//! 生成规则：TS 字面量联合 → Rust 枚举（带 serde rename）；
//! 判别联合 → serde 内部标签枚举；对象 → 结构体。
//! 输出按类型名字母序排列，保证生成结果可复现（CI 靠 git diff 校验无漂移）。
//!
//! 已知取舍：内联（未具名）的字面量联合退化为 String ——
//! 例如 RendererCapabilities.physics。等 character-schema 也纳入生成后消除。

use serde::{Deserialize, Serialize};

/// IPC 通道名 —— 与 TS 侧同源，禁止在 Rust 里另写一份字符串
pub const CHANNEL_SHELL_COMMAND: &str = "heartstar://shell-command";
pub const CHANNEL_RENDERER_EVENT: &str = "heartstar://renderer-event";
pub const CHANNEL_PANEL_COMMAND: &str = "heartstar://panel-command";
pub const CHANNEL_PANEL_EVENT: &str = "heartstar://panel-event";

/// 刻意写成 `(typeof CHARACTER_KINDS)[number]` 而不是 `z.infer<typeof CharacterKindSchema>`： 后者是调用表达式，protocol 的 schema 生成器（`ts-json-schema-generator`）解析不了， 一旦 protocol 引用 CharacterKind 就会生成失败。 与 semantics.ts 里 SemanticArea 的写法保持一致。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CharacterKind {
    #[serde(rename = "live2d")]
    Live2d,
    #[serde(rename = "spine")]
    Spine,
    #[serde(rename = "sprite")]
    Sprite,
    #[serde(rename = "vrm")]
    Vrm,
}

/// 角色摘要。面板只需要够列出按钮的字段，完整 manifest 由渲染层自己加载。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterSummary {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "kind")]
    pub kind: CharacterKind,
}

/// 帧预算。'paused' 用于窗口被完全遮挡时。
///
/// 刻意写成判别联合而不是 `number | 'paused'`： 后者是"原始类型 + 哨兵字符串"，映射到 Rust 时只能退化成 `serde_json::Value`（类型安全全丢）或 `untagged` 枚举（单元变体会序列化成 null，与 'paused' 对不上）。判别联合两侧都能生成严格类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FrameBudget {
    #[serde(rename = "fps")]
    Fps {
        #[serde(rename = "value")]
        value: f64,
    },
    #[serde(rename = "paused")]
    Paused,
}

/// 输入模式：穿透（桌面，靠全局钩子）/ 直连（面板内子窗口，正常收消息）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum InputMode {
    #[serde(rename = "passthrough")]
    Passthrough,
    #[serde(rename = "direct")]
    Direct,
}

/// 壳 → 面板
///
/// 刻意做成判别联合而不是单一对象：只有一个成员时 schema 生成器会退化成 结构体，`type` 变成普通字符串，字面量约束丢了；日后加成员时形状还会突变。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PanelCommand {
    #[serde(rename = "characterList")]
    CharacterList {
        #[serde(rename = "characters")]
        characters: Vec<CharacterSummary>,
    },
    #[serde(rename = "characterSwitched")]
    CharacterSwitched {
        #[serde(rename = "characterId")]
        character_id: String,
    },
    #[serde(rename = "characterFailed")]
    CharacterFailed {
        #[serde(rename = "message")]
        message: String,
    },
}

/// 面板 → 壳
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PanelEvent {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "switchCharacter")]
    SwitchCharacter {
        #[serde(rename = "characterId")]
        character_id: String,
    },
}

/// 宠物窗口形态。与 Rust 侧 PetForm 保持一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PetForm {
    #[serde(rename = "desktop")]
    Desktop,
    #[serde(rename = "panel")]
    Panel {
        #[serde(rename = "hostHandle")]
        host_handle: f64,
    },
}

/// 渲染后端能力。 上层应查询"你能做什么"，而不是判断"你是什么 kind"—— 这样 3D 能力升级时上层零改动，无 IK 的 2D 角色也能体面降级。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RendererCapabilities {
    /// 能否程序化摆姿势（直接写骨骼/参数）
    #[serde(rename = "proceduralPose")]
    pub procedural_pose: bool,
    /// 能否做反向动力学（伸手够鼠标、脚踩不平面）
    #[serde(rename = "ik")]
    pub ik: bool,
    /// 是否支持加性动画层（呼吸等叠加在 clip 之上）
    #[serde(rename = "additiveLayer")]
    pub additive_layer: bool,
    /// 物理类型：Live2D 内置 / VRM SpringBone / 无
    #[serde(rename = "physics")]
    pub physics: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RendererEvent {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "capabilities")]
        capabilities: RendererCapabilities,
    },
    #[serde(rename = "characterSwitched")]
    CharacterSwitched {
        #[serde(rename = "characterId")]
        character_id: String,
    },
    #[serde(rename = "hitTest")]
    HitTest {
        #[serde(rename = "area")]
        area: Option<SemanticArea>,
    },
    #[serde(rename = "frameStats")]
    FrameStats {
        #[serde(rename = "fps")]
        fps: f64,
        #[serde(rename = "frameMs")]
        frame_ms: f64,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "message")]
        message: String,
        #[serde(rename = "fatal")]
        fatal: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SemanticArea {
    #[serde(rename = "head")]
    Head,
    #[serde(rename = "body")]
    Body,
    #[serde(rename = "hand")]
    Hand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ShellCommand {
    #[serde(rename = "setForm")]
    SetForm {
        #[serde(rename = "form")]
        form: PetForm,
    },
    #[serde(rename = "setInputMode")]
    SetInputMode {
        #[serde(rename = "mode")]
        mode: InputMode,
    },
    #[serde(rename = "setBounds")]
    SetBounds {
        #[serde(rename = "x")]
        x: f64,
        #[serde(rename = "y")]
        y: f64,
        #[serde(rename = "width")]
        width: f64,
        #[serde(rename = "height")]
        height: f64,
    },
    #[serde(rename = "switchCharacter")]
    SwitchCharacter {
        #[serde(rename = "characterId")]
        character_id: String,
    },
    #[serde(rename = "setFrameBudget")]
    SetFrameBudget {
        #[serde(rename = "budget")]
        budget: FrameBudget,
    },
    #[serde(rename = "setGazeTarget")]
    SetGazeTarget {
        #[serde(rename = "nx")]
        nx: f64,
        #[serde(rename = "ny")]
        ny: f64,
    },
}
