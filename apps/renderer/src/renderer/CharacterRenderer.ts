import type {
  CharacterManifest,
  CharacterKind,
  RendererCapabilities,
  SemanticParam,
  SemanticArea,
  SemanticBone,
} from '@heart-star/character-schema';

/**
 * 角色渲染器接口 —— 2D 与 3D 的唯一契约。
 *
 * 上层（情感状态机、AI 标签映射、空闲调度）只依赖**语义**，
 * 永不感知底层是 Live2D 参数还是 VRM 骨骼。
 */

export type Vec3 = readonly [number, number, number];

/**
 * 骨骼句柄 —— 程序化操作的入口，仅 3D 提供。
 * 通过 capabilities 协商获取，上层不得假设它一定存在。
 */
export interface BoneHandle {
  /** 欧拉角写入（度）。受 manifest.rig.constraints 限制，超限将被夹紧。 */
  setRotationEuler(pitch: number, yaw: number, twist: number): void;
  /** IK 求解：让该骨骼所在链的末端够到目标点（模型空间） */
  solveIk(target: Vec3): void;
  /** 释放一次程序化覆盖，回落到 clip 驱动 */
  release(): void;
}

export interface MotionRequest {
  group: string;
  /** 省略时由 adapter 在组内随机挑选 */
  id?: string;
  /** 数值越大越优先。idle 类应始终使用最低优先级 */
  priority?: number;
}

export interface CharacterRenderer {
  readonly kind: CharacterKind;

  /**
   * 能力声明。上层应查询"你能做什么"，而不是判断"你是什么 kind"。
   * 这样 3D 能力升级时上层零改动，无 IK 的 2D 角色也能体面降级。
   */
  readonly capabilities: RendererCapabilities;

  load(manifest: CharacterManifest): Promise<void>;

  playMotion(req: MotionRequest): void;
  setExpression(id: string): void;

  /** 语义参数写入。adapter 内部完成语义 → 实际参数名/骨骼的映射。 */
  setParameter(semantic: SemanticParam, value: number): void;

  /** 视线跟随，归一化坐标（-1..1） */
  lookAt(nx: number, ny: number): void;

  /** 命中检测，返回语义部位。null 表示未命中。 */
  hitTest(x: number, y: number): SemanticArea | null;

  setBounds(width: number, height: number): void;

  /**
   * 用户缩放倍率。作用在 manifest.defaultScale **之上**。
   *
   * 可选方法：resize 与缩放不是一回事（前者改画布、后者改角色大小），
   * 但也不是每个后端都需要单独实现 —— 有些后端靠 setBounds 里的整体
   * 缩放矩阵就能顺带处理。留成可选，避免逼每个 adapter 都填一遍空壳。
   */
  setScale?(scale: number): void;

  /** 每帧调用。dt 单位秒。 */
  render(dt: number): void;

  dispose(): void;

  /**
   * 程序化骨骼操作。仅当 capabilities.proceduralPose 为 true 时可用。
   * 可选方法而非必选 —— 强制 2D 实现它只会产出空壳代码。
   */
  getBoneHandle?(bone: SemanticBone): BoneHandle | null;
}
