import type {
  CharacterManifest,
  RendererCapabilities,
  SemanticArea,
  SemanticParam,
} from '@heart-star/character-schema';
import type { PetForm } from '@heart-star/protocol';
import { loadManifest } from '../character/manifest';
import { CHARACTER_SCALE } from '@heart-star/protocol';
import type { CharacterRenderer } from '../renderer/CharacterRenderer';
import { createAdapter } from '../renderer/adapters';
import { GazeController } from './GazeController';

/**
 * 交互动作（被摸、被拎起来、打招呼…）的优先级。
 * 高于 idle，低于 AI 主动发起的动作。
 */
const INTERACTION_PRIORITY = 2;

/** 待机动作优先级。最低 —— 任何主动交互都能盖过它。 */
const IDLE_PRIORITY = 1;

import { FrameScheduler, type FrameRate } from './FrameScheduler';
import { IdleDirector } from './IdleDirector';
import { CLIPS, ClipPlayer, findClip, type Clip } from './ProceduralClip';

/**
 * 被放下之后的小反应。
 *
 * 光"落地"是一个物理事件，不是一次交流 —— 拖完就站着不动，
 * 和"她根本没感觉到被摸过"是一样的。补这一下才算真的有来有回。
 */
const AFTER_DROP: readonly Clip[] = [CLIPS.shakeHead, CLIPS.peek];

/** 落地后接一句的概率。留一点"什么也不说"的时候，不然每次都一样反而假。 */
const AFTER_DROP_CHANCE = 0.75;

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

const pick = <T>(items: readonly T[]): T => {
  const item = items[Math.floor(Math.random() * items.length)];
  // 非空常量数组，取不到只可能是索引算错 —— 真发生了也别崩在渲染循环里
  return (item ?? items[0]) as T;
};

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
   * 待机导演。
   *
   * 库（Live2D）的默认行为是"动作放完立刻接下一个待机"，角色几乎
   * 永不停歇。这件事由导演接管：什么时候动、动素材动作还是程序化动作、
   * 冷落久了要不要打瞌睡，都在这里定。
   */
  private readonly director = new IdleDirector();

  /** 程序化动作片段的播放器。与动作文件互斥，见 ProceduralClip 的说明。 */
  private readonly clips = new ClipPlayer();

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

    // 待机节奏从头开始：旧角色的进度留着没有意义，
    // 而且可能刚好在换上的一瞬间就甩出一个待机动作
    this.director.noteInteraction();
    // 没有待机动作文件的角色只能靠程序化动作撑着 ——
    // 否则它在没人理的时候会一动不动，看着和卡住了一样
    this.director.setIdleMotionAvailable((manifest.motions.idle?.length ?? 0) > 0);
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
      this.beginInteraction(renderer);
      this.playAssetMotion(renderer, `tap_${area}`);
    }
    return area;
  }

  /**
   * 播一个素材动作。
   *
   * 播之前必须先停掉正在播的那个：库对**同优先级**的动作是拒绝而不是打断
   * （`MotionManager.reserve()` 里 `priority <= currentPriority` 直接返回 false，
   * 而优先级只在动作自然播完时才归零）。于是一次交互动作没播完之前，
   * 后续所有交互动作都被静默丢弃 —— 连着摸她两下，第二下毫无反应，
   * 用户眼里就是"她卡住了、叫不动了"。
   * 先停一次把优先级清回 NONE，新的才排得进去。
   */
  private playAssetMotion(renderer: CharacterRenderer, group: string): void {
    renderer.stopMotion?.();
    renderer.playMotion({ group, priority: INTERACTION_PRIORITY });
  }

  /**
   * 播一个语义动作组（`greet` / `grab` / `drop` …）或程序化片段（`hop` …）。
   *
   * 入口有两类，都是"用户明确做了某件事"：壳层报的拖拽（被拎起来/放下）、
   * 面板上的互动按钮。它们都不带坐标 —— 命中判定只对点击有意义。
   *
   * 为什么把程序化片段也塞进同一个入口：对上层来说"播一个动作"就是
   * 播一个动作，它是素材动作还是合成的，上层不该知道也不该关心 ——
   * 否则每加一个合成动作就要在协议里加一条命令。
   *
   * 角色没有这个组时由 adapter 静默跳过：那是"这个角色没这套动作"，
   * 不是错误，不该弹到用户面前。
   */
  playMotion(group: string): void {
    const renderer = this.renderer;
    if (!renderer) return;

    const clip = findClip(group);
    if (clip) {
      // 先停掉正在播的素材动作：它每帧都会覆盖姿态参数，
      // 不停的话合成动作写的东西等于白写 —— 拖拽时最明显，
      // 按下那一下播的"被摸"反应会把"被拎起来"压掉两秒。
      renderer.stopMotion?.();

      if (group === 'drop') {
        // 落地也算一次交互：拖了很久再放手的话，"距上次交互"已经很长了，
        // 不重置的话她刚被放下就立刻接着打瞌睡 —— 看着像根本没醒过
        this.director.noteInteraction();
        // 落地之后补一个小反应，两拍连着播（播放器负责无缝接上）
        this.clips.play(
          clip,
          Math.random() < AFTER_DROP_CHANCE ? pick(AFTER_DROP) : null,
        );
        return;
      }

      // 合成动作不重排待机节奏：它本来就是"动一下"，
      // 跟着重置一次间隔反而会让接下来的待机来得莫名其妙地晚
      this.clips.play(clip);
      return;
    }

    this.beginInteraction(renderer);
    this.playAssetMotion(renderer, group);
  }

  /**
   * 一次主动交互开始了（被摸、被拎起来、面板按钮）。
   *
   * 三件事必须一起做，少一件交互感就散了：
   *  1. 停掉正在播的程序化片段 —— 动作会整帧覆盖姿态参数，
   *     不停的话片段那边还在写，看着像抽搐。
   *  2. 告诉导演"有人理她了"：待机排程重新计时，
   *     否则被摸的反应刚播到一半就被下一个待机动作接走。
   *  3. 若她正在打瞌睡，播"惊醒"。
   */
  private beginInteraction(renderer: CharacterRenderer): void {
    const rest = this.clips.stop();
    if (rest) {
      this.writeParams(renderer, rest);
      // 人也要放回地面 —— 停在半空接一个"被摸"的动作非常怪
      renderer.setLift?.(0);
    }

    const startle = this.director.noteInteraction();
    if (startle) this.clips.play(startle);
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

    // 程序化片段优先：它在播的时候不排任何动作 —— 动作会覆盖姿态参数，
    // 两者同时跑的结果是"看起来什么都没发生"
    const clipValues = this.clips.update(dt);
    // 离地量每帧都要发：它在片段结束后要自己归零，
    // 只在"有值"时写会让人永远悬在半空下不来
    renderer.setLift?.(this.clips.lift);
    if (clipValues) {
      this.writeParams(renderer, clipValues);
    } else {
      const plan = this.director.update(dt);
      if (plan?.kind === 'motion') {
        renderer.playMotion({ group: plan.group, priority: IDLE_PRIORITY });
      } else if (plan) {
        this.clips.play(plan.clip);
      }
    }

    // 视线按帧推进，而不是收到消息就写：消息是 30Hz 的离散输入，
    // 逐条直接写会让眼睛跳动
    const gaze = this.gaze.update(dt);
    renderer.lookAt(gaze.x, gaze.y);
    renderer.render(dt);
  }

  private writeParams(
    renderer: CharacterRenderer,
    values: Map<SemanticParam, number>,
  ): void {
    for (const [semantic, value] of values) {
      renderer.setParameter(semantic, value);
    }
  }
}
