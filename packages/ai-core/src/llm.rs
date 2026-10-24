//! LLM 编排
//!
//! 核心约束：LLM 输出的是**意图**，不是骨骼旋转、也不是参数名。
//! 本模块只负责把自然语言转成结构化意图，再由行为原语库翻译成动作。
//!
//! M4 实现要点：
//!  - 流式输出，首字延迟预算 < 800ms
//!  - 输出受约束的结构化标签（function calling / JSON mode），禁止自由文本后猜意图
//!  - 断网时降级到端侧小模型，而不是直接失败

/// LLM 意图（骨架：字段随行为原语库扩充）
#[derive(Debug, Clone, Default)]
pub struct Intent {
    pub emotion: Option<String>,
    pub action: Option<String>,
}
