import { z } from 'zod';
import { SEMANTIC_BONES } from './semantics.js';

/**
 * 角色包格式。
 *
 * zod schema 是唯一真源，TS 类型由 z.infer 反推 —— 不允许再手写一遍
 * interface，否则类型与运行时校验必然漂移。
 *
 * manifest 已从"资产描述"演进为"角色能力描述"：
 * semantics 声明语义映射，rig 声明骨骼与约束，capabilities 声明后端能力。
 */

export const CHARACTER_KINDS = ['live2d', 'spine', 'sprite', 'vrm'] as const;
export const CharacterKindSchema = z.enum(CHARACTER_KINDS);
/**
 * 刻意写成 `(typeof CHARACTER_KINDS)[number]` 而不是 `z.infer<typeof CharacterKindSchema>`：
 * 后者是调用表达式，protocol 的 schema 生成器（`ts-json-schema-generator`）解析不了，
 * 一旦 protocol 引用 CharacterKind 就会生成失败。
 * 与 semantics.ts 里 SemanticArea 的写法保持一致。
 */
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * 命中区域。用 discriminated union 而非可选字段大杂烩，
 * 这样 adapter 里 switch 能穷尽检查，新增类型时编译器会提醒补实现。
 */
export const HitAreaSchema = z.discriminatedUnion('type', [
  // 2D：Live2D Drawable
  z.object({ type: z.literal('drawable'), target: z.string().min(1) }),
  // 3D：包围盒
  z.object({ type: z.literal('box'), min: Vec3Schema, max: Vec3Schema }),
  // 3D：mesh 命名（可多个）
  z.object({ type: z.literal('mesh'), meshes: z.array(z.string().min(1)).min(1) }),
]);
export type HitArea = z.infer<typeof HitAreaSchema>;

/** 关节角度限制（度）—— 程序化驱动的安全阀 */
const JointConstraintSchema = z
  .object({
    yaw: z.tuple([z.number(), z.number()]).optional(),
    pitch: z.tuple([z.number(), z.number()]).optional(),
    twist: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

/** IK 链 */
const IkChainSchema = z.object({
  root: z.string().min(1),
  mid: z.string().min(1),
  end: z.string().min(1),
  poleHint: z.enum(['forward', 'backward', 'up', 'down']).optional(),
});

/**
 * 3D 骨骼装置。
 * bones     —— 语义骨骼名 → 模型实际骨骼名（VRM 可省略，走标准人形名）
 * constraints —— 角度限制。没有它，AI 程序化驱动迟早摆出反关节姿势
 * ikChains  —— 可求解的链
 * springBones —— 被动物理链（头发/裙摆）
 */
export const RigSchema = z.object({
  type: z.enum(['humanoid-vrm', 'custom', 'none']),
  bones: z.record(z.string(), z.string()).default({}),
  constraints: z.record(z.string(), JointConstraintSchema).default({}),
  ikChains: z.array(IkChainSchema).default([]),
  springBones: z.array(z.string()).default([]),
});
export type Rig = z.infer<typeof RigSchema>;

export const CapabilitiesSchema = z.object({
  proceduralPose: z.boolean().default(false),
  ik: z.boolean().default(false),
  additiveLayer: z.boolean().default(false),
  physics: z.enum(['builtin', 'springbone', 'none']).default('none'),
});

/**
 * 一个语义映射到的目标参数。
 *
 * 允许**多个**是必需的，不是可选的便利：Live2D 里一个语义天然对应多个参数 ——
 * 眨眼要同时写 `ParamEyeLOpen` 与 `ParamEyeROpen`，情绪要同时动眉毛与嘴形。
 * 只接受单个字符串的话，美术只能二选一，做出来就是"只眨一只眼"。
 */
export const ParamTargetSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);
export type ParamTarget = z.infer<typeof ParamTargetSchema>;

/**
 * 语义映射表。
 * .strict() 拒绝未知键 —— 美术把 ParamAngelX 拼错成 ParamAngleX 时立刻报错，
 * 而不是运行时静默失效。
 */
export const SemanticsSchema = z
  .object({
    lookX: ParamTargetSchema.optional(),
    lookY: ParamTargetSchema.optional(),
    breath: ParamTargetSchema.optional(),
    blink: ParamTargetSchema.optional(),
    lipSync: ParamTargetSchema.optional(),
    joy: ParamTargetSchema.optional(),
    anger: ParamTargetSchema.optional(),
    sadness: ParamTargetSchema.optional(),
    // 姿态类：程序化合成动作 writes 这些，见 semantics.ts 的说明
    poseX: ParamTargetSchema.optional(),
    poseY: ParamTargetSchema.optional(),
    poseZ: ParamTargetSchema.optional(),
    crouch: ParamTargetSchema.optional(),
    armRaise: ParamTargetSchema.optional(),
  })
  .strict();

export const CharacterManifestSchema = z.object({
  id: z.string().min(1),
  kind: CharacterKindSchema,
  /** schema 版本。从第一天就留，将来 migrate(v1→v2) 有落脚点。 */
  version: z.number().int().positive().default(1),
  displayName: z.string().optional(),

  /** 资产入口：2D 为 model3.json，3D 为 .vrm / .glb。
   *  程序化角色（如 M1 的占位方块）没有资产文件，可省略；
   *  资产型 adapter 拿不到它会在加载时报错，所以契约层不强行要求。 */
  entry: z.string().min(1).optional(),

  /** 归一化锚点（0..1），决定角色对齐屏幕/面板的位置 */
  anchor: z.object({ x: z.number(), y: z.number() }).default({ x: 0.5, y: 1 }),
  defaultScale: z.number().positive().default(0.35),

  semantics: SemanticsSchema,

  /**
   * 命中区域。用显式 object 而非 `z.record(z.enum(...), ...)`：
   * record 的枚举键会产出「全键必填」类型，与 .default({}) 冲突。
   * object 还能自动剥离未知键，美术写错部位名时会直接报错。
   */
  hitAreas: z
    .object({
      head: HitAreaSchema.optional(),
      body: HitAreaSchema.optional(),
      hand: HitAreaSchema.optional(),
    })
    .default({}),

  /** 动作组 → 动作 id 列表。键为 MotionGroup 或 tap_<area> / emote_<emotion> */
  motions: z.record(z.string(), z.array(z.string())).default({}),
  expressions: z.record(z.string(), z.string()).default({}),

  /** 仅 3D 需要 */
  camera: z
    .object({ fov: z.number().positive(), distance: z.number().positive() })
    .optional(),

  rig: RigSchema.default({
    type: 'none',
    bones: {},
    constraints: {},
    ikChains: [],
    springBones: [],
  }),

  capabilities: CapabilitiesSchema.default({
    proceduralPose: false,
    ik: false,
    additiveLayer: false,
    physics: 'none',
  }),
});

export type CharacterManifest = z.infer<typeof CharacterManifestSchema>;

/** 骨骼语义名集合，供 validate 做未知键检查 */
export const SEMANTIC_BONE_SET: ReadonlySet<string> = new Set(SEMANTIC_BONES);
