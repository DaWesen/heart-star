/**
 * 语义字典 —— 跨团队唯一真源。
 *
 * 设计约束：上层行为层（情感状态机、AI 标签映射、空闲调度）只认语义，
 * 永不感知底层是 Live2D 参数还是 VRM 骨骼。改这里等于改全产品的能力边界，
 * 任何增删都需跨团队评审。
 */

/** 全部语义参数。封闭集合，manifest 中使用 .strict() 拒绝未知键。 */
export const SEMANTIC_PARAMS = [
  'lookX',
  'lookY',
  'breath',
  'blink',
  'lipSync',
  'joy',
  'anger',
  'sadness',
] as const;
export type SemanticParam = (typeof SEMANTIC_PARAMS)[number];

/**
 * 核心必填项 —— 缺失即构建期失败（error 级）。
 * 依据：眼动与口型是桌宠"活着"的底线，不能靠降级蒙混。
 */
export const REQUIRED_PARAMS = ['lookX', 'lookY', 'lipSync'] as const satisfies
  readonly SemanticParam[];

/** 可选语义 —— 缺失时由 SemanticFallback 静默降级（warning 级）。 */
export const OPTIONAL_PARAMS: readonly SemanticParam[] = SEMANTIC_PARAMS.filter(
  (p) => !(REQUIRED_PARAMS as readonly string[]).includes(p),
);

/**
 * 情绪类语义参数 —— 三者互斥，由 EmotionStateMachine 驱动。
 * 单独抽出来的原因：情绪是"状态"而非"连续量"，
 * 若与 lookX/breath 这类混在一起，状态机无从判断是否该切换。
 */
export const EMOTION_PARAMS = ['joy', 'anger', 'sadness'] as const;
export type EmotionParam = (typeof EMOTION_PARAMS)[number];

export const isEmotionParam = (p: string): p is EmotionParam =>
  (EMOTION_PARAMS as readonly string[]).includes(p);

/** 语义部位 —— 命中检测的结果语义，2D 与 3D 必须收敛到同一套。 */
export const SEMANTIC_AREAS = ['head', 'body', 'hand'] as const;
export type SemanticArea = (typeof SEMANTIC_AREAS)[number];

/** 动作组 —— 前四个为约定组，`tap_<area>` / `emote_<emotion>` 为派生命名。 */
export const MOTION_GROUPS = ['idle', 'greet', 'sleep', 'wake'] as const;
export type MotionGroup = (typeof MOTION_GROUPS)[number];

/** 派生动作组名：点击部位反馈 */
export const tapGroup = (area: SemanticArea): `tap_${SemanticArea}` => `tap_${area}`;
/** 派生动作组名：情绪表达 */
export const emoteGroup = (emotion: SemanticParam): `emote_${SemanticParam}` =>
  `emote_${emotion}`;

/**
 * 3D rig 骨骼语义 —— VRM 标准人形骨骼的子集。
 * 非 VRM 的 glTF（Mixamo / MMD / Blender）需在 manifest.rig.bones 里做命名映射。
 */
export const SEMANTIC_BONES = [
  'head',
  'neck',
  'chest',
  'spine',
  'hip',
  'upperArmL',
  'upperArmR',
  'lowerArmL',
  'lowerArmR',
  'handL',
  'handR',
] as const;
export type SemanticBone = (typeof SEMANTIC_BONES)[number];

/**
 * 渲染后端能力。
 * 上层应查询"你能做什么"，而不是判断"你是什么 kind"——
 * 这样 3D 能力升级时上层零改动，无 IK 的 2D 角色也能体面降级。
 */
export interface RendererCapabilities {
  /** 能否程序化摆姿势（直接写骨骼/参数） */
  proceduralPose: boolean;
  /** 能否做反向动力学（伸手够鼠标、脚踩不平面） */
  ik: boolean;
  /** 是否支持加性动画层（呼吸等叠加在 clip 之上） */
  additiveLayer: boolean;
  /** 物理类型：Live2D 内置 / VRM SpringBone / 无 */
  physics: 'builtin' | 'springbone' | 'none';
}
