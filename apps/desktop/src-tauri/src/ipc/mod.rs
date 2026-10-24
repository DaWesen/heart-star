//! IPC：壳 ↔ 渲染 ↔ 面板，以及 AI 侧车
//!
//! 消息结构由 packages/protocol 定义，Rust 侧由 JSON Schema 生成 serde 结构，
//! **禁止手写镜像** —— 手写必然与 TS 侧不同步。
//!
//! M2 实现时在此处补 tauri::ipc::Channel / invoke  handler。
