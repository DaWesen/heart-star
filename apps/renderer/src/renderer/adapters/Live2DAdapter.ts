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
    definitions?: Record<string, Array<{ File?: string } | undefined>>;
    /**
     * 动作状态机。只声明要改的那一个方法 —— 它决定"动作放完要不要自动接 idle"，
     * 而库默认是"要"，角色因此几乎从不停下来。
     */
    state?: { shouldRequestIdleMotion?: () => boolean };
    stopAllMotions?(): void;
  };
}

/** 参数范围读不到时的兜底。眼球/角度类参数常见量级。 */
const FALLBACK_RANGE = { min: -1, max: 1 };

/**
 * `setLift(1)` 时上移多少个身高。
 *
 * 取 0.18 是"脚明显离地但人没飞出去"—— 桌宠被鼠标拎着走就该是这一点点。
 */
const LIFT_RANGE = 0.22;

/**
 * "头部带"占模型总高的比例。
 *
 * 人形角色的头大致落在这一段里；取小了会点不中，取大了会把胸口也判成头。
 */
const HEAD_BAND_RATIO = 0.28;

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

  /**
   * 模型在**模型画布坐标系**里的纵向范围，载入时锁定。
   *
   * 锁的是载入瞬间的初始姿态：之后它会随动作摆动，
   * 用实时包围盒的话"头部带"会随着呼吸上下漂，判定就不稳了。
   */
  private modelTop = 0;
  private modelHeight = 0;

  /** 参数范围缓存。模型载入后范围是静态的，见 paramRange。 */
  private readonly paramRanges = new Map<string, { min: number; max: number }>();

  /** 落地时的 y（fit 得出的），被拎起来的位移以它为基准 */
  private baseY = 0;
  /** 当前离地量，单位见 setLift */
  private lift = 0;

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
    this.measureModel();

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

    const resolved = this.resolveMotion(req.group, req.id);
    void model
      // 组不存在会 reject；这里是"这个角色没有对应动作"，静默即可，
      // 抛出去会让整条切换链路被判为失败。
      .motion(resolved.group, resolved.index, req.priority)
      .catch(() => undefined);
  }

  /**
   * 语义动作组 → 模型里的真实组（+ 可选索引）。
   *
   * 两级解析，先后次序是有讲究的：
   *
   * 1. **组名归一化匹配**：model3.json 里习惯写 `Idle` / `Tap@Body`，
   *    我们的语义组名是 `idle` / `tap_body`，忽略大小写与 `@ _ -` 后相等即命中。
   * 2. **按 manifest 声明的动作文件反查**：模型的组名是美术起的
   *    （日和身上是 `Flick` / `FlickUp` / `Tap`…），和我们的语义组名
   *    （`greet` / `grab` / `drop`）对不上，而这层不能靠猜。
   *    manifest 里写的是"这个语义组由哪几个动作文件组成"，
   *    拿着文件名去 model3 的组里找，就能得到它真正的组名与下标。
   *
   *    为什么不在 model3.json 里把组名直接改成语义名：`runtime/` 是不入库的
   *    （见 NOTICE.md），改它等于改一份别人拿不到的文件，
   *    下次拿到官方原包就全丢。manifest 入库，映射关系必须由它持有。
   *
   * 命中多个文件时随机挑一个 —— 同一语义组里挂几个动作就是为了有变化。
   */
  private resolveMotion(group: string, id?: string): { group: string; index?: number } {
    const byName = this.resolveGroup(group);
    if (byName !== group) {
      // 组名对上了，索引交给库在组内随机（除非调用方指定了）
      return { group: byName, index: this.motionIndex(id) };
    }

    const candidates = this.filesToSlots(group);
    if (candidates.length === 0) {
      return { group, index: this.motionIndex(id) };
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (!pick) return { group, index: this.motionIndex(id) };
    return { group: pick.group, index: pick.index };
  }

  /** `id` 是数字字符串时作为组内下标；省略则由库随机。 */
  private motionIndex(id?: string): number | undefined {
    if (id === undefined) return undefined;
    const n = Number(id);
    return Number.isNaN(n) ? undefined : n;
  }

  /** manifest 里该语义组的动作文件 → model3 中对应的（组, 下标）。 */
  private filesToSlots(group: string): { group: string; index: number }[] {
    const files = this.manifest?.motions[group];
    const definitions = this.internals()?.motionManager?.definitions;
    if (!files?.length || !definitions) return [];

    const slots: { group: string; index: number }[] = [];
    for (const file of files) {
      const wanted = file.replace(/^.*\//, '').toLowerCase();
      for (const [name, entries] of Object.entries(definitions)) {
        const index = (entries ?? []).findIndex(
          (e) => (e?.File ?? '').replace(/^.*\//, '').toLowerCase() === wanted,
        );
        if (index >= 0) {
          slots.push({ group: name, index });
          break;
        }
      }
    }
    return slots;
  }

  stopMotion(): void {
    this.internals()?.motionManager?.stopAllMotions?.();
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
    const onModel = this.hitsSilhouette(internals, local.x, local.y);

    // 头的几何推断必须**最先**判：官方模型的 HitArea 常是一整块覆盖全身的
    // 透明 drawable（日和就是），它的包围盒连头一起盖住 ——
    // 无论是先判语义区还是先做就近兜底，摸头都会被吞成 body（实测正是如此）。
    // 美术真标了 head 的话，几何判定和标注也必然一致，不存在冲突。
    if (onModel && this.hitsHeadBand(local.y)) return 'head';

    // 命中的是模型内部的 drawable 名，翻回语义部位。
    // 只看 drawable 型：Cubism 的命中区域就是 drawable，
    // box / mesh 是给 3D 用的包围体，这里没有对应的命中来源。
    const hits = internals.hitTest(local.x, local.y);
    for (const [area, def] of Object.entries(this.manifest?.hitAreas ?? {})) {
      if (def.type === 'drawable' && hits.includes(def.target)) return area as SemanticArea;
    }

    // 落到这一步的是"点在角色身上、但没盖进任何标注区"的情况
    return onModel ? this.nearestArea(internals, local.x, local.y) : null;
  }

  /**
   * 头部判定 —— 模型没标 head 命中区时的几何兜底。
   *
   * 日和的 drawable 名是一串 `ArtMeshNN`，从名字看不出哪块是脸，
   * 而 model3 里手标的命中区只有胸口一块（`HitArea`），
   * 于是"摸头"这个最自然的交互根本无从下手。
   *
   * 这里用**相对高度**判：点了角色轮廓，且落在模型总高的顶部一小段里，
   * 就算摸头。人形角色的头就在这一段，够用且不用改素材。
   * 美术一旦标了 `hitAreas.head`，上面的精确判定会先命中，本兜底自然让位。
   */
  private hitsHeadBand(y: number): boolean {
    // 载入时测的可能是未初始化的顶点（模型还没跑过第一次 update，
    // drawable 顶点全是 0），测不出范围就先放弃 —— 等真的要点它时再补测。
    if (this.modelHeight <= 0) this.measureModel();
    if (this.modelHeight <= 0) return false;
    return y <= this.modelTop + this.modelHeight * HEAD_BAND_RATIO;
  }

  /** 语义命中区都没盖住时，取**离点击最近**的标注部位。
   *
   * 语义命中区是美术在模型里手标的 drawable（日和只有一块），
   * 盖不住头发、裙摆、腿这些大面积部位 —— 而命中判定随动作摆动还会漂移。
   * 点在角色身上却毫无反应，用户只会把点击当成坏的；
   * 比起"部位判错"，"摸到了却没反应"严重得多。
   *
   * 部位取**离点击最近的标注区**：只有一个标注区时必然选中它，
   * 有多个时也大概率符合直觉。是否点在角色身上由调用方先行判定
   * （见 hitTest 里的 onModel），点在轮廓之外（窗口空白处）返回 null。
   */
  private nearestArea(internals: Live2DInternals, x: number, y: number): SemanticArea | null {
    const areas = Object.entries(this.manifest?.hitAreas ?? {}).filter(
      ([, def]) => def.type === 'drawable',
    );
    if (areas.length === 0) return null;

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

  /** 量出模型的纵向范围（所有 drawable 顶点的并集）。 */
  private measureModel(): void {
    const internals = this.internals();
    const verticesOf = internals?.getDrawableVertices;
    const count = internals?.coreModel?.getDrawableCount?.() ?? 0;
    if (!verticesOf || !internals || count <= 0) return;

    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const v = verticesOf.call(internals, i);
      if (!v) continue;
      for (let k = 1; k < v.length; k += 2) {
        const y = v[k] as number;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;

    this.modelTop = top;
    this.modelHeight = bottom - top;
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
    // 范围属于这个模型，换了角色就不该再带着走
    this.paramRanges.clear();
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
    // 参数范围在模型载入之后就是静态的，而这里是**每帧每参数**都要走的
    // 热路径 —— 一次查范围要三次 core 调用（找下标 + 读 min + 读 max），
    // 十来个姿态参数每帧就是几十次。缓存掉它们，热路径只剩一次写值。
    const cached = this.paramRanges.get(name);
    if (cached) return cached;

    const core = this.internals()?.coreModel;
    const index = core?.getParameterIndex?.(name) ?? -1;
    if (index < 0) return FALLBACK_RANGE;

    const min = core?.getParameterMinimumValue?.(index);
    const max = core?.getParameterMaximumValue?.(index);
    if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
      return FALLBACK_RANGE;
    }
    const range = { min, max };
    this.paramRanges.set(name, range);
    return range;
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

    // 落地位置：被拎起来的位移要从这里起算，
    // 而每次 fit（改窗口大小 / 改缩放）都会重算一次落位
    this.baseY = model.position.y;
    this.applyLift();
  }

  setLift(ratio: number): void {
    this.lift = clampSigned(ratio);
    this.applyLift();
  }

  /**
   * 整体上移/下移 —— **位移**，不是姿态。
   *
   * 姿态参数只能让模型转、倾、屈，"被拎起来"最要紧的那一下
   * （脚离开地面）却只能靠位移表达：拉着她走的时候窗口跟着鼠标动，
   * 相对运动为零，光靠姿态再怎么扭都看不出"她被提起来了"。
   *
   * 单位用**身高的比例**而不是像素：这样不同角色、不同缩放下
   * 抬起来的观感一致，不用为每个模型单独调一个数。
   */
  private applyLift(): void {
    const model = this.model;
    if (!model || this.height <= 0) return;

    const bodyHeight = this.naturalHeight * model.scale.y;
    model.position.y = this.baseY - this.lift * bodyHeight * LIFT_RANGE;
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

/**
 * 点是否在多边形内（奇偶规则）。顶点形如 [x0, y0, x1, y1, …]。
 *
 * `j` 用取模算而不是常见的 `for (…; j = i++)`：那种写法把自增塞进增量表达式里，
 * 漏写一个 `++` 就是**一个永不终止的循环**（`i` 不再前进），而它表现得不抛错、
 * 不报错 —— 只是命中判定再也不返回，渲染层从此一动不动，连重载都救不回来。
 * 踩过一次，这里宁可多一次取模也要把推进写清楚。
 */
const pointInPolygon = (x: number, y: number, v: ArrayLike<number>): boolean => {
  const n = v.length >> 1;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0; i < n; i += 1) {
    const j = (i + n - 1) % n;
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
