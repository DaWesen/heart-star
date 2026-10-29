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
  // —— 姿态类（程序化合成动作用）——
  // 存在的理由：动作文件是素材，素材只有美术能造，数量也永远不够用。
  // 而"探头""摇头""蹦一下"这类小动作，本质是几个姿态参数随时间走一条曲线，
  // 完全可以自己合成 —— 前提是有语义能描述"身体朝哪偏"，
  // 而不是在代码里写死 ParamAngleZ 这种模型私有名。
  //
  // 约定：**0.5 为中立**（不偏不倚），两端为极限 —— 姿态参数的范围是
  // 由模型自己声明的（-30..30 之类），"中立"在中点，不在 0。
  'poseX', // 左右（脸/身体朝左还是朝右）
  'poseY', // 上下（抬头 / 低头）
  'poseZ', // 歪头（左右倾）
  'crouch', // 下沉（屈腿 / 身体压低），0 为自然
  'armRaise', // 抬手，0 为放下
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

/**
 * 动作组 —— 前六个为约定组，`tap_<area>` / `emote_<emotion>` 为派生命名。
 *
 * `grab` / `drop` 是桌宠独有的：宠物会被鼠标直接"拎起来"再"放下"，
 * 这是它与一般 Live2D 看板娘最不一样的一次交互，
 * 必须有一等公民的名字 —— 拿 `tap_body` 凑会让"被拎起来"和"被摸一下"
 * 在语义层变成同一件事，上层再也分不开该播哪个。
 */
export const MOTION_GROUPS = ['idle', 'greet', 'sleep', 'wake', 'grab', 'drop'] as const;
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
