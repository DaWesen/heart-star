//! 语音识别
//!
//! M4 实现。可选：云端流式 ASR / 本地 whisper.cpp / FunASR。
//! 必须与 vad.rs 配合：VAD 先切出有效语音段，再送入 ASR，避免全程上传空白音频。
