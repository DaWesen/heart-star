import type {
  CharacterManifest,
  RendererCapabilities,
  SemanticArea,
  SemanticParam,
} from '@heart-star/character-schema';
import type { CharacterRenderer, MotionRequest } from '../CharacterRenderer';
import { CHARACTER_SCALE } from '@heart-star/protocol';
import { ensureCubismCore } from '../../character/cubismCore';

// 只用类型引用，不产生运行时依赖：pixi 与 pixi-live2d-display 都在 load() 里
// 动态 import，只装 2D 角色的用户不会为 3D 付带宽，反之亦然。
import type { Application } from 'pixi.js';
import type { Live2DModel } from 'pixi-live2d-display/cubism4';

/**
 * Live2D adapter —— PixiJS v7 + pixi-live2d-display + Cubism Web SDK。
 *
 * 两条刻意的设计选择：
 *
 * 1. **帧由宿主驱动，不用 Pixi 自己的 ticker。**
 *    关掉 autoStart / autoUpdate，在 render(dt) 里手写 update + render。
 *    这样降帧策略（空闲 15fps）才能真正作用到模型上 —— 否则 Pixi 的 ticker
 *    会自顾自按 60fps 跑，帧预算调了等于没调。
 *
 * 2. **参数一律经语义字典。**
 *    上层写的是 lookX / blink / breath，本类负责翻译成 ParamEyeBallX 等实际
 *    参数名。manifest 里没声明的语义直接跳过：上层已经按 capabilities 裁剪过，
 *    这里再兜一层是为了"模型没这个参数"时安静降级，而不是抛错炸掉。
 */

/**
 * pixi-live2d-display 内部模型的形状。
 * 只声明用得到的部分 —— 它的完整类型随版本漂移，全量引入反而脆。
 */
interface Live2DInternals {
  coreModel?: {
    setParameterValueById?(id: string, value: number): void;
    getParameterIndex?(id: string): number;
    getParameterMinimumValue?(index: number): number;
    getParameterMaximumValue?(index: number): number;
  };
  hitTest?(x: number, y: number): string[];
  motionManager?: { definitions?: Record<string, unknown> };
}

/** 参数范围读不到时的兜底。眼球/角度类参数常见量级。 */
const FALLBACK_RANGE = { min: -1, max: 1 };

export class Live2DAdapter implements CharacterRenderer {
  readonly kind = 'live2d' as const;

  readonly capabilities: RendererCapabilities = {
    // 能直接写参数，这就是程序化驱动
    proceduralPose: true,
    ik: false,
    // Live2D 的参数叠加天然是加性的：呼吸可以叠在待机动作之上
    additiveLayer: true,
    physics: 'builtin',
  };

  private app: Application | null = null;
  private model: Live2DModel | null = null;
  private manifest: CharacterManifest | null = null;
  private width = 0;
  private height = 0;
  /** 用户缩放倍率。夹在 CHARACTER_SCALE 区间内，叠在 defaultScale 之上 */
  private userScale: number = CHARACTER_SCALE.default;

  constructor(private readonly container: HTMLElement) {}

  async load(manifest: CharacterManifest): Promise<void> {
    // Core 必须比 pixi-live2d-display 先就位：后者在模块初始化时就会去找它。
    // 顺序反了会得到一句毫无信息量的 "Cubism Core is not found"。
    await ensureCubismCore();

    const entry = manifest.entry;
    if (!entry) {
      throw new Error(`角色 ${manifest.id} 的 manifest 缺少 entry，无法定位模型文件`);
    }

    const [pixi, display] = await Promise.all([
      import('pixi.js'),
      import('pixi-live2d-display/cubism4'),
    ]);

    const app = new pixi.Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      // 交给 RendererHost 的帧调度驱动，别自己跑 ticker
      autoStart: false,
      powerPreference: 'high-performance',
    });

    this.container.appendChild(app.view as unknown as HTMLCanvasElement);

    const model = await display.Live2DModel.from(`/characters/${manifest.id}/${entry}`, {
      autoUpdate: false,
      autoFocus: false,
      autoInteract: false,
    });

    app.stage.addChild(model);

    this.app = app;
    this.model = model;
    this.manifest = manifest;

    const measured = this.measure();
    this.applyBounds(measured.width, measured.height);
  }

  playMotion(req: MotionRequest): void {
    const model = this.model;
    if (!model) return;

    const index = Number.isNaN(Number(req.id)) ? undefined : Number(req.id);
    // 动作组名对大小写不敏感：model3.json 里习惯写 Idle / TapBody，
    // 而我们的语义组名是 idle / tap_body，直接传会找不到组。
    void model
      .motion(this.resolveGroup(req.group), index, req.priority)
      // 组不存在会 reject；这里是用户点了没对应动作，静默即可，
      // 抛出去会让整条切换链路被判为失败。
      .catch(() => undefined);
  }

  setExpression(id: string): void {
    const model = this.model;
    if (!model) return;

    // manifest.expressions 给的是文件路径，而 pixi-live2d-display 认的是
    // model3.json 里的表情名 —— 从文件名推出名字（去掉目录与后缀）。
    const file = this.manifest?.expressions[id];
    const name = file ? file.replace(/^.*\//, '').replace(/\.exp3?\.json$/i, '') : id;

    void model.expression(name).catch(() => undefined);
  }

  setParameter(semantic: SemanticParam, value: number): void {
    const target = this.manifest?.semantics[semantic];
    // manifest 没声明这个语义 = 模型没有对应参数，安静跳过
    if (!target) return;

    const names = Array.isArray(target) ? target : [target];
    for (const name of names) {
      // 约定：blink 的 1 = 完全闭合，而 ParamEye*Open 的 1 = 完全睁开。
      // 语义字典只表达"是什么"，不表达"方向"，方向差异留在 adapter 里吸收。
      const unit = semantic === 'blink' ? 1 - clamp01(value) : clamp01(value);
      this.writeParam(name, unit);
    }
  }

  lookAt(nx: number, ny: number): void {
    // 视线是 -1..1 的双向量，其余语义都是 0..1 的单向量
    this.writeSemantic('lookX', clampSigned(nx));
    this.writeSemantic('lookY', clampSigned(ny));
  }

  hitTest(x: number, y: number): SemanticArea | null {
    const internals = this.internals();
    if (!internals?.hitTest) return null;

    const hits = internals.hitTest(x, y);
    if (hits.length === 0) return null;

    // 命中的是模型内部的 drawable 名，翻回语义部位。
    // 只看 drawable 型：Cubism 的命中区域就是 drawable，
    // box / mesh 是给 3D 用的包围体，这里没有对应的命中来源。
    for (const [area, def] of Object.entries(this.manifest?.hitAreas ?? {})) {
      if (def.type === 'drawable' && hits.includes(def.target)) return area as SemanticArea;
    }
    return null;
  }

  setBounds(width: number, height: number): void {
    // 壳层在窗口尚未落位时可能下发 0，拿 0 去 resize 会让画面空白
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width <= 0 || height <= 0) return;

    this.applyBounds(width, height);
  }

  setScale(scale: number): void {
    this.userScale = clamp(scale, CHARACTER_SCALE.min, CHARACTER_SCALE.max);
    this.fit();
  }

  render(dt: number): void {
    const app = this.app;
    const model = this.model;
    if (!app || !model) return;

    // Live2DModel.update 收的是毫秒
    model.update(dt * 1000);
    app.renderer.render(app.stage);
  }

  dispose(): void {
    // 只拆 app：children: true 会连带销毁挂在 stage 上的模型。
    // 再单独调一次 model.destroy() 会把它销毁两遍，Pixi 上表现为空指针。
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });

    this.model = null;
    this.app = null;
    this.manifest = null;
  }

  private internals(): Live2DInternals | null {
    // internalModel 的类型随版本漂移，这里按结构断言，避免在类型层硬绑定
    return (this.model?.internalModel as unknown as Live2DInternals | undefined) ?? null;
  }

  private writeSemantic(semantic: SemanticParam, unit: number): void {
    const target = this.manifest?.semantics[semantic];
    if (!target) return;

    const names = Array.isArray(target) ? target : [target];
    for (const name of names) {
      this.writeParam(name, unit);
    }
  }

  /**
   * 把 0..1 / -1..1 的语义量写进具体参数。
   * 参数范围以模型自身声明为准（Cubism core 能读到 min/max），
   * 读不到才退回 ±1 —— 硬编码角度范围会让不同模型的表现差一个量级。
   */
  private writeParam(name: string, unit: number): void {
    const core = this.internals()?.coreModel;
    if (!core?.setParameterValueById) return;

    const { min, max } = this.paramRange(name);
    // 单向量（breath / lipSync…）用 0..1 直接映射；
    // 双向量（lookX / lookY）的 -1..1 先归一到 0..1 再映射
    const t = unit >= 0 ? unit : (unit + 1) / 2;

    core.setParameterValueById(name, min + t * (max - min));
  }

  private paramRange(name: string): { min: number; max: number } {
    const core = this.internals()?.coreModel;
    const index = core?.getParameterIndex?.(name) ?? -1;
    if (index < 0) return FALLBACK_RANGE;

    const min = core?.getParameterMinimumValue?.(index);
    const max = core?.getParameterMaximumValue?.(index);
    if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
      return FALLBACK_RANGE;
    }
    return { min, max };
  }

  /**
   * 语义组名 → model3.json 里的组名。
   *
   * 两边的命名习惯不一样：model3 写 `Idle` / `Tap@Body`，语义组名是
   * `idle` / `tap_body`。只比大小写的话 `tap_body` 对不上 `Tap@Body`（_ 对 @），
   * 于是点击反馈会静默失效 —— 点宠物没反应，且日志里什么都没有。
   * 这里按"去掉所有非字母数字后相等"来匹配。
   */
  private resolveGroup(group: string): string {
    const definitions = this.internals()?.motionManager?.definitions ?? {};
    const normalized = normalize(group);
    return Object.keys(definitions).find((key) => normalize(key) === normalized) ?? group;
  }

  private applyBounds(width: number, height: number): void {
    const app = this.app;
    const model = this.model;
    if (!app || !model) return;

    this.width = width;
    this.height = height;

    app.renderer.resize(width, height);
    this.fit();
  }

  /**
   * 模型缩放与落位。
   * anchor 与 defaultScale 都来自 manifest —— 不同模型的"脚在哪、多大"是美术决定，
   * 不该由渲染代码拍脑袋。
   */
  private fit(): void {
    const model = this.model;
    const manifest = this.manifest;
    if (!model || !manifest || this.width <= 0 || this.height <= 0) return;

    const fitScale = Math.min(this.width / model.width, this.height / model.height);
    model.scale.set(fitScale * manifest.defaultScale * this.userScale);

    model.anchor.set(manifest.anchor.x, manifest.anchor.y);
    model.position.set(this.width * manifest.anchor.x, this.height * manifest.anchor.y);
  }

  private measure(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
    return {
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
    };
  }
}

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampSigned = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** 组名比对用的归一化：忽略大小写与 @ _ - 这类分隔符差异 */
const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
