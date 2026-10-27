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
import type { Application, Point } from 'pixi.js';
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
    getDrawableCount?(): number;
  };
  hitTest?(x: number, y: number): string[];
  /** 语义命中区之外做轮廓兜底用的 drawable 几何（模型画布坐标系）。 */
  getDrawableIndex?(id: string): number;
  getDrawableVertices?(index: number): ArrayLike<number>;
  motionManager?: {
    definitions?: Record<string, unknown>;
    /**
     * 动作状态机。只声明要改的那一个方法 —— 它决定"动作放完要不要自动接 idle"，
     * 而库默认是"要"，角色因此几乎从不停下来。
     */
    state?: { shouldRequestIdleMotion?: () => boolean };
  };
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
  /**
   * 模型的**自然**画布尺寸（未叠加任何缩放），载入时锁定。
   *
   * 为什么必须单独存一份、而不是每次读 `model.width`：Pixi 的
   * `DisplayObject.width` 是 `getLocalBounds() × scale`，**含当前 transform**。
   * 拿它当 fit 的分母，就会变成"以上一次的结果算这一次"的自反馈：
   * S_n · S_{n-1} = 常数，于是每按一次滑条就在"巨大 / 正常"之间来回跳。
   */
  private naturalWidth = 0;
  private naturalHeight = 0;

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

    // 必须在"还没动过 scale"的这一刻取自然尺寸：
    // 之后 model.width 就带上我们写的缩放了（见 naturalWidth 的注释）。
    // 除以当前 scale 是为了连 SDK 自带的初始缩放也一并剥离。
    this.naturalWidth = divide(model.width, model.scale.x);
    this.naturalHeight = divide(model.height, model.scale.y);

    this.app = app;
    this.model = model;
    this.manifest = manifest;

    // 必须在模型开始 update 之前关掉：一旦跑起来，库就会在第一帧
    // 立刻排一个 idle 进去（此时没有任何动作在播）。
    this.suppressAutoIdle();

    const measured = this.measure();
    this.applyBounds(measured.width, measured.height);
  }

  /**
   * 关掉库自带的 idle 自动续接。
   *
   * 库在 `MotionManager.update()` 里写着：动作一放完，只要当前没有
   * 待机组（`shouldRequestIdleMotion()`），就**立刻**随机再起一个 idle。
   * 于是待机动作首尾相接、永不停歇 —— 角色一直在做小动作，
   * 用户主动点一下触发的反应反而被淹没，看上去像"我做什么它都没反应"。
   *
   * 这里把"什么时候放待机"收归上层（渲染宿主按间隔排），
   * 本类只负责让库别自作主张。
   *
   * 关掉之后角色并不会僵住：呼吸、眨眼、物理（头发/衣服摆动）
   * 在库里都是独立于动作的，没有动作时照常运行。
   */
  private suppressAutoIdle(): void {
    const state = this.internals()?.motionManager?.state;
    if (!state) return;

    // 覆盖的是原型方法：写成实例属性就能遮蔽它，不动原型（否则会波及所有模型）
    state.shouldRequestIdleMotion = () => false;
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
    const model = this.model;
    const internals = this.internals();
    if (!model || !internals?.hitTest) return null;

    // 契约给的是画布（世界）坐标，而 internalModel.hitTest 要的是
    // "原始模型画布"坐标 —— 模型被缩放平移过，两套坐标差着一整个变换。
    // 少这一步转换的后果是**永远命中不到**，而且没有任何报错可循。
    // （库里的 Live2DModel.hitTest 就是先 toModelPosition 再转交 internalModel，
    //  这里绕开它是因为要拿 drawable 名翻语义部位，而不是只要命中区域名。）
    //
    // 第二个参数必须**显式传**：它的默认值是 `position.clone()`，
    // 而这里传的是普通对象（没有 clone 方法），走默认值就是一次 TypeError。
    // 付出的代价是两个入参都得断言成 Point —— 只为不引入 pixi 的运行时依赖。
    const local = model.toModelPosition({ x, y } as Point, { x: 0, y: 0 } as Point);
    const hits = internals.hitTest(local.x, local.y);

    // 命中的是模型内部的 drawable 名，翻回语义部位。
    // 只看 drawable 型：Cubism 的命中区域就是 drawable，
    // box / mesh 是给 3D 用的包围体，这里没有对应的命中来源。
    for (const [area, def] of Object.entries(this.manifest?.hitAreas ?? {})) {
      if (def.type === 'drawable' && hits.includes(def.target)) return area as SemanticArea;
    }

    return this.fallbackArea(internals, local.x, local.y);
  }

  /**
   * 语义命中区没盖住时的兜底。
   *
   * 语义命中区是美术在模型里手标的一小块 drawable（日和只有胸口一块），
   * 盖不住头发、裙摆、腿这些大面积部位 —— 而命中判定随动作摆动还会漂移。
   * 点在角色身上却毫无反应，用户只会把点击当成坏的；
   * 比起"部位判错"，"摸到了却没反应"严重得多。
   *
   * 所以只要点落在模型的多边形轮廓里，就按"摸到了"处理，
   * 部位取**离点击最近的标注区**：只有一个标注区时必然选中它，
   * 有多个时也大概率符合直觉。点在角色轮廓之外（窗口空白处）仍返回 null。
   */
  private fallbackArea(internals: Live2DInternals, x: number, y: number): SemanticArea | null {
    const areas = Object.entries(this.manifest?.hitAreas ?? {}).filter(
      ([, def]) => def.type === 'drawable',
    );
    if (areas.length === 0) return null;
    if (!this.hitsSilhouette(internals, x, y)) return null;

    let best: SemanticArea | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const [area, def] of areas) {
      if (def.type !== 'drawable') continue;
      const bounds = this.drawableBounds(internals, def.target);
      if (!bounds) continue;
      const d = distanceToRect(x, y, bounds);
      if (d < bestDist) {
        bestDist = d;
        best = area as SemanticArea;
      }
    }
    return best;
  }

  /** 点是否落在模型的任一 drawable 多边形里（≈ 点在角色身上）。 */
  private hitsSilhouette(internals: Live2DInternals, x: number, y: number): boolean {
    const verticesOf = internals.getDrawableVertices;
    const count = internals.coreModel?.getDrawableCount?.() ?? 0;
    if (!verticesOf || count <= 0) return false;

    for (let i = 0; i < count; i += 1) {
      const v = verticesOf.call(internals, i);
      if (v && pointInPolygon(x, y, v)) return true;
    }
    return false;
  }

  /** 单个 drawable（按 id）在模型画布坐标系里的包围盒。 */
  private drawableBounds(
    internals: Live2DInternals,
    id: string,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const index = internals.getDrawableIndex?.(id);
    const v = index !== undefined && index >= 0 ? internals.getDrawableVertices?.(index) : null;
    if (!v || v.length < 2) return null;

    let minX = v[0] as number;
    let maxX = minX;
    let minY = v[1] as number;
    let maxY = minY;
    for (let i = 2; i < v.length; i += 2) {
      minX = Math.min(minX, v[i] as number);
      maxX = Math.max(maxX, v[i] as number);
      minY = Math.min(minY, v[i + 1] as number);
      maxY = Math.max(maxY, v[i + 1] as number);
    }
    return { minX, minY, maxX, maxY };
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
    //
    // 纹理与 baseTexture **刻意不销毁**：切换角色时新实例要先建、旧的随后才拆，
    // 两者并存期间纹理是同一批对象（Pixi 按来源缓存），销毁旧的会把新模型
    // 正在用的纹理一起释放 —— 表现是角色变黑、身体变成一块长方形，
    // 而控制台不会有任何报错，极难定位。纹理由全局缓存持有，不该由实例回收。
    this.app?.destroy(true, { children: true, texture: false, baseTexture: false });

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

    // 用载入时锁定的自然尺寸，而不是 model.width —— 后者随已在生效的缩放变化，
    // 会让 fit 变成自反馈（详见 naturalWidth 注释）。
    const baseWidth = this.naturalWidth > 0 ? this.naturalWidth : divide(model.width, model.scale.x);
    const baseHeight =
      this.naturalHeight > 0 ? this.naturalHeight : divide(model.height, model.scale.y);
    if (baseWidth <= 0 || baseHeight <= 0) return;

    const fitScale = Math.min(this.width / baseWidth, this.height / baseHeight);
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

/** 剥离已生效的缩放，取回自然尺寸。scale 为 0 或非法时退回当前 width。 */
const divide = (value: number, scale: number): number =>
  Number.isFinite(scale) && scale !== 0 ? value / scale : value;

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampSigned = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** 组名比对用的归一化：忽略大小写与 @ _ - 这类分隔符差异 */
const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 点是否在多边形内（奇偶规则）。顶点形如 [x0, y0, x1, y1, …]。 */
const pointInPolygon = (x: number, y: number, v: ArrayLike<number>): boolean => {
  const n = v.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i) {
    const xi = v[i * 2] as number;
    const yi = v[i * 2 + 1] as number;
    const xj = v[j * 2] as number;
    const yj = v[j * 2 + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

/** 点到矩形的最短距离（点在矩形内时为 0）。 */
const distanceToRect = (
  x: number,
  y: number,
  r: { minX: number; minY: number; maxX: number; maxY: number },
): number => {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dy = Math.max(r.minY - y, 0, y - r.maxY);
  return Math.hypot(dx, dy);
};
