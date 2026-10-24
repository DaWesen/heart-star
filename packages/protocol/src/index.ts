/**
 * IPC 消息契约 —— 壳(desktop) / 渲染(renderer) / 面板(panel) / AI(ai-core) 的唯一真源。
 *
 * 三条铁律：
 *  1. 命令（Command）有 requestId 且期待响应；事件（Event）单向广播。
 *  2. Rusl 侧由 JSON Schema 生成 serde 结构，禁止手写镜像 —— 手写必然不同步。
 *  3. 本包不依赖任何 app，也不被 app 反向依赖修改。
 *
 * 消息分类：
 *   ShellCommand    壳  → 渲染
 *   RendererEvent   渲染 → 壳
 *   AiEvent         AI  → 渲染（流式，非请求响应）
 *
 * 依赖方向：本包单向依赖 character-schema（语义字典是更底层的真源），
 * 反向依赖与循环依赖均禁止。
 */
import type { RendererCapabilities, SemanticArea } from '@heart-star/character-schema';

// ---------- 形态与输入 ----------

/** 宠物窗口形态。与 Rust 侧 PetForm 保持一一对应。 */
export type PetForm =
  | { kind: 'desktop' }
  | { kind: 'panel'; hostHandle: number };

/** 输入模式：穿透（桌面，靠全局钩子）/ 直连（面板内子窗口，正常收消息） */
export type InputMode = 'passthrough' | 'direct';

// ---------- 壳 → 渲染 ----------

export type ShellCommand =
  /** 形态切换。渲染侧只需调整背景合成方式，窗口搬运由壳负责。 */
  | { type: 'setForm'; form: PetForm }
  | { type: 'setInputMode'; mode: InputMode }
  | { type: 'setBounds'; x: number; y: number; width: number; height: number }
  /** 切换角色。渲染侧按 kind 懒加载对应 adapter，并完整 dispose 旧实例。 */
  | { type: 'switchCharacter'; characterId: string }
  /** 帧预算。'paused' 用于窗口被完全遮挡时。 */
  | { type: 'setFrameBudget'; fps: number | 'paused' }
  /** 鼠标归一化坐标（-1..1），供 GazeController 使用 */
  | { type: 'setGazeTarget'; nx: number; ny: number };

// ---------- 渲染 → 壳 ----------

export type RendererEvent =
  | { type: 'ready'; capabilities: RendererCapabilities }
  /** 命中检测结果，语义部位；null 表示未命中 */
  | { type: 'hitTest'; area: SemanticArea | null }
  | { type: 'frameStats'; fps: number; frameMs: number }
  | { type: 'error'; message: string; fatal: boolean };

// ---------- AI → 渲染（流式）----------

export type LookTarget = 'user' | 'away' | 'cursor';

/**
 * AI 语义标签 —— 渲染层唯一消费的智能产物。
 * 这里绝不能出现骨骼名或参数名：那是 manifest.semantics 的职责。
 * 链路：LLM 意图 → 行为原语 → 语义标签 → manifest 映射 → 骨骼/参数
 */
export interface SemanticTag {
  emotion?: string;
  /** 动作组名，如 'greet' / 'tap_head' */
  motion?: string;
  look?: LookTarget;
  /** 说话状态，驱动 lipSync */
  speaking?: boolean;
}

export type AiEvent =
  | { type: 'semanticTag'; tag: SemanticTag }
  /** 流式文本增量，供面板展示气泡 */
  | { type: 'textDelta'; delta: string }
  | { type: 'textEnd' }
  | { type: 'audioChunk'; data: ArrayBuffer }
  | { type: 'audioEnd' };

// ---------- 面板 → AI ----------

export type AiCommand =
  | { type: 'chat'; text: string }
  | { type: 'startListening' }
  | { type: 'stopListening' }
  | { type: 'interrupt' };

// ---------- 信封 ----------

/** 命令信封：带 requestId，期待响应 */
export interface CommandEnvelope<T> {
  requestId: string;
  payload: T;
}

/** 响应信封 */
export interface ResponseEnvelope<T> {
  requestId: string;
  ok: boolean;
  payload?: T;
  error?: string;
}
