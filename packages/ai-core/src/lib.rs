//! AI 侧车
//!
//! 职责边界：只产出「语义标签」与音频流，**不感知任何渲染实现**。
//! 链路：LLM 意图 → 行为原语 → 语义标签 →（manifest 映射）→ 骨骼/参数
//!
//! 关键约束：本 crate 中不得出现骨骼名、Live2D 参数名等渲染侧概念。

pub mod asr;
pub mod llm;
pub mod memory;
pub mod tts;
pub mod vad;

use serde::{Deserialize, Serialize};

/// 视线目标
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LookTarget {
    User,
    Away,
    Cursor,
}

/// AI 输出的语义标签。
/// 与 TS 侧 `SemanticTag` 一一对应，由 protocol 包生成，禁止手工同步。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTag {
    pub emotion: Option<String>,
    pub motion: Option<String>,
    pub look: Option<LookTarget>,
    pub speaking: Option<bool>,
}

/// 编排入口（骨架：M4 实现）
pub async fn handle_user_input(_text: &str) -> Result<SemanticTag, String> {
    todo!("M4：接 LLM + 记忆检索 + 行为原语映射")
}
