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
 *   PanelEvent      面板 → 壳（请求）
 *   PanelCommand    壳  → 面板（下发）
 *   AiEvent         AI  → 渲染（流式，非请求响应）
 *
 * 为什么面板不直接对渲染发命令：渲染层只认壳这一个命令来源。
 * 多一个来源就要多维护一份"谁有权改窗口/角色"的规则，
 * 而壳本来就是窗口与形态的唯一权威，让它当中转是零成本的。
 *
 * 依赖方向：本包单向依赖 character-schema（语义字典是更底层的真源），
 * 反向依赖与循环依赖均禁止。
 */
import type {
  CharacterKind,
  RendererCapabilities,
  SemanticArea,
} from '@heart-star/character-schema';

// ---------- 形态与输入 ----------

/** 宠物窗口形态。与 Rust 侧 PetForm 保持一一对应。 */
export type PetForm =
  | { kind: 'desktop' }
  | { kind: 'panel'; hostHandle: number };

/** 输入模式：穿透（桌面，靠全局钩子）/ 直连（面板内子窗口，正常收消息） */
export type InputMode = 'passthrough' | 'direct';

/**
 * 帧预算。'paused' 用于窗口被完全遮挡时。
 *
 * 刻意写成判别联合而不是 `number | 'paused'`：
 * 后者是"原始类型 + 哨兵字符串"，映射到 Rust 时只能退化成
 * `serde_json::Value`（类型安全全丢）或 `untagged` 枚举（单元变体会序列化成
 * null，与 'paused' 对不上）。判别联合两侧都能生成严格类型。
 */
export type FrameBudget = { kind: 'fps'; value: number } | { kind: 'paused' };

// ---------- 壳 → 渲染 ----------

export type ShellCommand =
  /** 形态切换。渲染侧只需调整背景合成方式，窗口搬运由壳负责。 */
  | { type: 'setForm'; form: PetForm }
  | { type: 'setInputMode'; mode: InputMode }
  | { type: 'setBounds'; x: number; y: number; width: number; height: number }
  /** 切换角色。渲染侧按 kind 懒加载对应 adapter，并完整 dispose 旧实例。 */
  | { type: 'switchCharacter'; characterId: string }
  /**
   * 缩放当前角色。
   *
   * 这是作用在 manifest.defaultScale **之上**的用户倍率：
   * 美术定下"这个角色在画布里多大"，用户再按自己的摆放需要微调，
   * 两者不该混成一个数字 —— 否则用户的偏好会随美术改 defaultScale 一起漂。
   */
  | { type: 'setCharacterScale'; scale: number }
  /** 帧预算。'paused' 用于窗口被完全遮挡时。 */
  | { type: 'setFrameBudget'; budget: FrameBudget }
  /** 鼠标归一化坐标（-1..1），供 GazeController 使用 */
  | { type: 'setGazeTarget'; nx: number; ny: number }
  /**
   * 一次点击，坐标是**宠物窗口客户区的 CSS 像素**（左上角为原点）。
   *
   * 命中判定放在渲染层：只有它知道 Live2D 的 drawable / VRM 的射线，
   * 壳层只知道有个指针按下了。由渲染层自己判完再播对应部位的动作，
   * 省掉一次"壳问渲染、渲染答、壳再命令渲染"的往返 ——
   * 那三跳里任何一跳断了都会变成"点了没反应且没有任何日志"。
   */
  | { type: 'tap'; x: number; y: number }
  /**
   * 播一个语义动作组（`'greet'` / `'grab'` / `'drop'` …，见语义字典）。
   *
   * 通用的"播动作"入口：拖拽（被拎起来/放下）、面板上的互动按钮都走它，
   * 而不是各自定义一条消息 —— 动作组的集合会随语义字典增长，
   * 每加一个组就加一条命令，等于把字典在协议里抄第二份。
   *
   * 角色没有这个组时渲染层静默跳过：那是"这个角色没这套动作"，
   * 不是错误，也不该弹到用户面前。
   */
  | { type: 'playMotion'; group: string };

// ---------- 渲染 → 壳 ----------

export type RendererEvent =
  | { type: 'ready'; capabilities: RendererCapabilities }
  /** 角色切换完成。壳据此通知面板更新高亮 */
  | { type: 'characterSwitched'; characterId: string }
  /**
   * 缩放已生效。带的是**夹紧后**的实际值 —— 面板滑块据此回显，
   * 否则用户把滑块拖到底，看到的数字和模型实际大小对不上。
   */
  | { type: 'characterScaled'; characterId: string; scale: number }
  /** 命中检测结果，语义部位；null 表示未命中 */
  | { type: 'hitTest'; area: SemanticArea | null }
  | { type: 'frameStats'; fps: number; frameMs: number }
  | { type: 'error'; message: string; fatal: boolean };

// ---------- 面板 ↔ 壳 ----------

/** 角色摘要。面板只需要够列出按钮的字段，完整 manifest 由渲染层自己加载。 */
export interface CharacterSummary {
  id: string;
  displayName: string;
  kind: CharacterKind;
  /**
   * 该角色声明了哪些动作组（manifest.motions 的键，语义组名）。
   *
   * 面板据此把"能播什么"列成按钮：动作组是逐角色不同的资产事实，
   * 面板拿不到文件系统、渲染层才知道自己装了什么，
   * 只有壳扫得到 —— 少这一项，试播按钮就只能写死一组合集，
   * 换角色立刻对不上。
   */
  motionGroups: string[];

  /**
   * 素材署名（来自角色包的 manifest.credits）。
   *
   * 为什么要一路带到面板：署名是素材方的条款，必须展示在「关于」页，
   * 而它属于**角色** —— 面板拿不到文件系统，写死在 UI 里又会在换角色时
   * 挂着上一个角色的声明。只有壳扫得到，所以由它带出来。
   *
   * 展平成三个可选字符串而不是一个可选对象：给 Rust 侧的生成器面对
   * 嵌套可选结构时行为不确定，扁平字段只用到 Option<String> 这种已验证的形态。
   */
  creditAttribution?: string;
  creditAuthors?: string;
  creditSource?: string;
}

/**
 * 用户可调的角色缩放区间。
 *
 * 放在契约包而不是各自 app 里：面板滑块的 min/max 与渲染层的夹紧边界
 * 必须是同一组数字，否则会出现"滑块显示 200% 但模型只到 150%"这类
 * 两边各说各话的问题。
 */
export const CHARACTER_SCALE = { min: 0.5, max: 2, default: 1, step: 0.05 } as const;

/**
 * 帧率档位 —— 用户可调。
 *
 * 为什么把"空闲之后降到多少"交给用户：桌宠是常驻进程，有人动画要丝滑、
 * 不在乎功耗，有人用笔记本插着电池、宁可它慢一点也不许费电。
 * 这个权衡只有用户知道，写死任何一个值都是在替用户决定。
 *
 * 区间同样放在契约里而不是各自 app 里：面板滑块的 min/max 与壳层的夹紧
 * 边界必须是同一组数字，否则会出现"面板显示 60 但实际只跑 30"这类问题。
 */
export const FRAME_PROFILE = {
  /** 有交互时的帧率上限 */
  active: { min: 15, max: 60, step: 5, default: 60 },
  /** 空闲一段时候降到的帧率 */
  idle: { min: 5, max: 60, step: 5, default: 15 },
  /** 无交互多久算空闲（秒）。原型阶段的观测值，先不开放调节 */
  idleAfterSecs: 30,
} as const;

/**
 * 程序化（合成）动作的 id —— 渲染层自己算出来的动作，不依赖素材文件。
 *
 * 放进契约而不是让面板硬编码：面板要列按钮，而"渲染层会合成哪些动作"
 * 是渲染层的能力事实。硬编码在面板里的后果是渲染层加一个动作、
 * 面板立刻少一个按钮，且没有任何报错。
 *
 * 它们与素材动作组共用一个 `playMotion` 入口（`ShellCommand.playMotion`），
 * 上层不需要区分"这是素材动作还是合成的"。
 */
export const PROCEDURAL_CLIPS = [
  'peek', // 探头
  'shakeHead', // 摇头
  'hop', // 蹦一下
  'stretch', // 伸懒腰
  'grab', // 被拎起来（循环保持，和拖拽触发的是同一个）
  'drop', // 被放下
  'doze', // 打瞌睡（循环，点一下会一直点头）
  'startle', // 惊醒
] as const;
export type ProceduralClip = (typeof PROCEDURAL_CLIPS)[number];

/** 面板 → 壳 */
export type PanelEvent =
  | { type: 'ready' }
  | { type: 'switchCharacter'; characterId: string }
  | { type: 'setCharacterScale'; scale: number }
  /**
   * 开关开机自启。
   *
   * 只有"设"，没有"读"：状态一律由壳下发（见 `PanelCommand.autostartChanged`），
   * 面板不主动查询。读也走一条消息的话，两边就都能持有各自的版本，
   * 而"谁的状态才是真的"这个问题不该存在 —— 真相只有注册表那一份。
   */
  | { type: 'setAutostart'; enabled: boolean }
  /**
   * 设置帧率档位。两个值一起下发而不是各发一条：
   * 它们是一组配置，分两次的话中间会出现"活跃档已降、空闲档还没降"的过渡态，
   * 而这个中间态本身没有任何意义。
   */
  | { type: 'setFrameProfile'; activeFps: number; idleFps: number }
  /** 让宠物播一个动作（如打招呼）。由壳层转成 `ShellCommand.playMotion` 转发。 */
  | { type: 'playMotion'; group: string };

/**
 * 壳 → 面板
 *
 * 刻意做成判别联合而不是单一对象：只有一个成员时 schema 生成器会退化成
 * 结构体，`type` 变成普通字符串，字面量约束丢了；日后加成员时形状还会突变。
 */
export type PanelCommand =
  | { type: 'characterList'; characters: CharacterSummary[] }
  /** 切换成功，面板据此更新"当前角色"高亮 */
  | { type: 'characterSwitched'; characterId: string }
  /** 切换失败（如 adapter 未实现、manifest 解析失败）。面板要能把原因显示出来 */
  | { type: 'characterFailed'; message: string }
  /** 缩放已生效，值为夹紧后的结果。面板滑块据此回显 */
  | { type: 'characterScaled'; characterId: string; scale: number }
  /**
   * 开机自启状态。
   *
   * 带的是**写完后回读**的结果，不是用户刚输入的值：注册表写入可能被策略或
   * 杀软拦下，此时回显会把面板上的勾选拨回去。用户看到的永远是真实状态，
   * 而不是"我以为设成功了"。
   */
  | { type: 'autostartChanged'; enabled: boolean }
  /** 帧率档位已生效。值为夹紧后的结果，面板据此回显 */
  | { type: 'frameProfileChanged'; activeFps: number; idleFps: number };

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

// ---------- 通道名 ----------

/**
 * IPC 通道名 —— Rust 与 TS 共用同一份常量。
 *
 * 通道名和消息结构一样属于契约：两侧各写一份字符串迟早会漂移，
 * 而这类 bug 的表现是"消息静默丢失"，极难定位。所以放在契约包里，
 * 由 `pnpm gen:rust` 一并生成到 Rust 侧。
 */
export const IPC_CHANNELS = {
  /** 壳 → 渲染：ShellCommand */
  shellCommand: 'heartstar://shell-command',
  /** 渲染 → 壳：RendererEvent */
  rendererEvent: 'heartstar://renderer-event',
  /** 壳 → 面板：PanelCommand */
  panelCommand: 'heartstar://panel-command',
  /** 面板 → 壳：PanelEvent */
  panelEvent: 'heartstar://panel-event',
} as const;

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
