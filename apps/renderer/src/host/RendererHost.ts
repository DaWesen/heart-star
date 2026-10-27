import type {
  CharacterManifest,
  RendererCapabilities,
  SemanticArea,
} from '@heart-star/character-schema';
import type { PetForm } from '@heart-star/protocol';
import { loadManifest } from '../character/manifest';
import { CHARACTER_SCALE } from '@heart-star/protocol';
import type { CharacterRenderer } from '../renderer/CharacterRenderer';
import { createAdapter } from '../renderer/adapters';
import { GazeController } from './GazeController';

/** 点击反馈的动作优先级。高于 idle，低于 AI 主动发起的动作。 */
const TAP_PRIORITY = 2;

/** 待机动作优先级。最低 —— 任何主动交互都能盖过它。 */
const IDLE_PRIORITY = 1;

/**
 * 两次待机动作之间的间隔（秒），在这个区间里随机取值。
 *
 * 定成十几秒量级是刻意的：待机小动作的意义是"它活着"，
 * 而不是"它一直在表演"。连成一片之后，用户主动点一下的反应
 * 就淹没在里面了 —— 看上去像点了没反应。
 */
const IDLE_GAP_MIN_SEC = 12;
const IDLE_GAP_MAX_SEC = 24;

/**
 * 换角后第一次待机的间隔（秒）。
 *
 * 比常规间隔短得多：刚切过来的角色如果一二十秒纹丝不动，
 * 第一眼会被误判成"卡住了 / 没加载出来"。
 */
const IDLE_FIRST_GAP_MIN_SEC = 3;
const IDLE_FIRST_GAP_MAX_SEC = 7;
import { FrameScheduler, type FrameRate } from './FrameScheduler';

/**
 * 占位角色的着色：由角色 id 派生一个色相。
 *
 * 只是 M1 的临时手段 —— 现在所有 sprite 角色共用一个占位方块，
 * 不给它上色的话"换了个角色"在画面上完全没有区别，切换链路好不好使没法验证。
 * 等真实 adapter 落地（M2）颜色就来自角色自己的贴图，这个函数可以直接删掉。
 */
function tintFor(characterId: string): string {
  let hash = 0;
  for (let i = 0; i < characterId.length; i += 1) {
    hash = (hash * 31 + characterId.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 70% 72%)`;
}

/**
 * 渲染宿主
 *
 * 职责：canvas 生命周期、adapter 懒加载与切换、帧调度、背景合成模式。
 * 不职责：不碰 Win32，不感知窗口形态的搬运过程（那是壳层的事）。
 *
 * 形态切换时本类只调整**背景合成方式**：
 *   desktop —— 透出用户桌面
 *   panel   —— 透出面板的背景层，并被前景层遮挡
 * 两个形态下宠物层都保持透明，这个一致性让渲染代码只需一套合成逻辑。
 */
export class RendererHost {
  private readonly scheduler: FrameScheduler;
  private renderer: CharacterRenderer | null = null;
  private capabilities: RendererCapabilities | null = null;
  /**
   * 用户缩放倍率，存在宿主而不是 adapter 上。
   * 换角色是"换掉整个 adapter"，倍率是用户偏好，不该跟着 adapter 一起丢。
   */
  private scale: number = CHARACTER_SCALE.default;
  private characterId: string | null = null;

  /**
   * 视线平滑器。
   *
   * 放在宿主而不是 adapter 上：换角色不该让视线"归零重来"，
   * 而 adapter 是随角色一起换掉的。
   */
  private readonly gaze = new GazeController();

  /**
   * 待机动作排程器。
   *
   * 库（Live2D）的默认行为是"动作放完立刻接下一个待机"，角色几乎
   * 永不停歇。本类接管这件事：待机是**间隔**发生的，中间留出静止，
   * 让用户主动交互的动作能被看见。
   */
  private idleElapsed = 0;
  private idleGap = randomBetween(IDLE_FIRST_GAP_MIN_SEC, IDLE_FIRST_GAP_MAX_SEC);

  /**
   * 帧统计回调，由 IpcBridge 注入。
   * 放在宿主上而不是调度器上，是为了让"上报"这件事留在 IPC 层，
   * 渲染宿主自身不感知壳层。
   */
  onStats: ((fps: number, frameMs: number) => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    this.scheduler = new FrameScheduler(
      (dt) => this.tick(dt),
      (fps, frameMs) => this.onStats?.(fps, frameMs),
    );
  }

  getCapabilities(): RendererCapabilities | null {
    return this.capabilities;
  }

  /** 加载角色。会完整 dispose 旧实例 —— 同一时刻只允许一个 adapter 存活。 */
  async loadCharacter(manifest: CharacterManifest): Promise<void> {
    // 动态 import 是刻意的：Vite 会把它切成独立 chunk，
    // 只装 2D 角色的用户永远不下载 three.js
    //
    // 顺序也刻意是"先建新的、成功了再丢旧的"：反过来（先 dispose 再加载）的话，
    // 一旦新 adapter 抛错（如 Live2D adapter 尚未实现），画面上就什么都不剩了 ——
    // 用户看到的是角色凭空消失，而不是一条能看明白的错误。
    const next = await createAdapter(manifest.kind, this.element);
    await next.load(manifest);

    // 把当前倍率带给新角色：用户调好的大小不该因为换角色被重置
    next.setScale?.(this.scale);

    this.renderer?.dispose();
    this.renderer = next;
    this.capabilities = next.capabilities;
    this.characterId = manifest.id;

    // 新角色从头开始排：旧角色的进度留着没有意义，
    // 而且可能刚好在换上的一瞬间就甩出一个待机动作
    this.resetIdle(IDLE_FIRST_GAP_MIN_SEC, IDLE_FIRST_GAP_MAX_SEC);
  }

  /** 当前角色 id。角色切换完成前为 null。 */
  getCharacterId(): string | null {
    return this.characterId;
  }

  /** 按 id 切换角色：加载 manifest → 建 adapter → 换掉旧的。 */
  async switchCharacter(characterId: string): Promise<void> {
    // 重复点同一个角色（双击按钮太容易发生）**不重新加载**。
    // 重载要再建一个 Pixi Application、再解析一遍模型，而旧的要等新的就位
    // 才能销毁 —— 两份并存期间旧实例销毁会把新模型正在用的资源一起释放，
    // 表现为"角色变黑、身体变成一块长方形"。已经在显示的角色直接跳过。
    //
    // 只在**载入成功**后才记 id，所以上次失败过的角色还能重试。
    if (characterId === this.characterId) return;

    const manifest = await loadManifest(characterId);
    await this.loadCharacter(manifest);

    this.element.style.setProperty('--character-tint', tintFor(characterId));
    this.scheduler.start();
  }

  /** M1 占位角色：会动的方块，用于验证窗口层而不引入渲染库干扰变量 */
  async usePlaceholder(): Promise<void> {
    const { PlaceholderAdapter } = await import('../renderer/adapters/PlaceholderAdapter');
    const next = new PlaceholderAdapter(this.element);

    this.renderer?.dispose();
    this.renderer = next;
    this.capabilities = next.capabilities;
    this.scheduler.start();
  }

  /**
   * 形态只写进 dataset，不存字段：当前渲染层除了 CSS 之外不需要读它，
   * 存一份同步两份状态的字段只会带来"改了一个忘了另一个"的风险。
   */
  setForm(form: PetForm): void {
    // 两个形态下 root 都保持透明，差异交由壳层的窗口层级（Z 序）处理
    this.element.dataset.form = form.kind;
  }

  setFrameBudget(budget: FrameRate): void {
    this.scheduler.setBudget(budget);
  }

  setBounds(width: number, height: number): void {
    this.renderer?.setBounds(width, height);
  }

  /** 视线目标（-1..1）。由壳层按指针位置下发，渲染层不认屏幕坐标。 */
  setGazeTarget(nx: number, ny: number): void {
    this.gaze.setTarget(nx, ny);
  }

  /**
   * 一次点击（客户区 CSS 像素）。
   *
   * 命中判定在这里做：只有渲染层知道模型的形状。
   * 命中了就播对应部位的动作（语义组名 `tap_<部位>`，如 tap_body），
   * 没命中就什么都不做 —— 点在空白处本来就不该有反应。
   *
   * @returns 命中的语义部位，未命中返回 null
   */
  tap(x: number, y: number): SemanticArea | null {
    const renderer = this.renderer;
    if (!renderer) return null;

    const area = renderer.hitTest(x, y);
    if (area) {
      renderer.playMotion({ group: `tap_${area}`, priority: TAP_PRIORITY });

      // 交互刚发生就把待机往后推：否则被摸的反应可能刚播到一半
      // 就被下一个待机动作接上，"我点它才有反应"这件事就白做了
      this.resetIdle();
    }
    return area;
  }

  /**
   * 设置用户缩放倍率。
   *
   * 返回**夹紧后**的实际生效值：面板滑块要回显它，否则拖到边界时
   * 显示的百分比和模型实际大小对不上。没有角色时返回 null（无从生效）。
   */
  setScale(scale: number): number | null {
    const next = Math.min(
      CHARACTER_SCALE.max,
      Math.max(CHARACTER_SCALE.min, Number.isFinite(scale) ? scale : CHARACTER_SCALE.default),
    );
    this.scale = next;

    const renderer = this.renderer;
    if (!renderer) return null;

    renderer.setScale?.(next);
    return next;
  }

  /** 当前生效的缩放倍率 */
  getScale(): number {
    return this.scale;
  }

  private tick(dt: number): void {
    const renderer = this.renderer;
    if (!renderer) return;

    this.pumpIdle(dt, renderer);

    // 视线按帧推进，而不是收到消息就写：消息是 30Hz 的离散输入，
    // 逐条直接写会让眼睛跳动
    const gaze = this.gaze.update(dt);
    renderer.lookAt(gaze.x, gaze.y);
    renderer.render(dt);
  }

  /**
   * 按间隔排一次待机动作。
   *
   * 间隔从"上一次排程"起算，而不是从"动作播完"起算：
   * 动作时长随角色和文件变，去追问它会把这份逻辑绑死在具体模型上。
   * 撞上还在播的动作也不要紧 —— idle 优先级最低，库会直接拒绝这次请求
   * （详见 Live2DAdapter.suppressAutoIdle 引用的那段库代码），
   * 结果只是"少播一次"，不会出现两个动作打架。
   */
  private pumpIdle(dt: number, renderer: CharacterRenderer): void {
    this.idleElapsed += dt;
    if (this.idleElapsed < this.idleGap) return;

    renderer.playMotion({ group: 'idle', priority: IDLE_PRIORITY });
    this.resetIdle();
  }

  /** 重新抽一次待机间隔。不传参数时用常规区间。 */
  private resetIdle(
    min = IDLE_GAP_MIN_SEC,
    max = IDLE_GAP_MAX_SEC,
  ): void {
    this.idleElapsed = 0;
    // 固定间隔会让人看出节拍，随机一下才像"它自己想动一下"
    this.idleGap = randomBetween(min, max);
  }
}

const randomBetween = (min: number, max: number): number =>
  min + Math.random() * (max - min);
