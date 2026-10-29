import { CLIPS, type Clip } from './ProceduralClip';

/**
 * 待机导演 —— 决定"没人理她的时候她在干什么"。
 *
 * 单独抽成一个类的理由：这件事的规则会一直长（时间段、情绪、随机性、
 * 以后还要接 AI 的意图），塞进 RendererHost 会让它从"渲染宿主"
 * 变成一个什么都管的上帝类。这里只做**决策**，执行仍在宿主。
 *
 * 三档，按"多久没人理她"切换：
 *   - 活跃（< 30s）：偶尔动一下，间隔短
 *   - 安静（30s ~ 2min）：动得更少，且掺入程序化小动作（探头、摇头…）
 *   - 打瞌睡（> 2min）：进入点头循环，直到被叫醒
 *
 * 30s 这个边界与壳层的降帧阈值（`FRAME_PROFILE.idleAfterSecs`）对齐：
 * 用户眼里的"它闲下来了"和"它开始省电"应该是同一件事，
 * 两个阈值不一致会出现"已经在省电了却还在活泼地动"的割裂感。
 */
const QUIET_AFTER_SEC = 30;
const DROWSY_AFTER_SEC = 120;

/** 活跃档的待机间隔（秒）。 */
const ACTIVE_GAP_MIN_SEC = 12;
const ACTIVE_GAP_MAX_SEC = 24;

/** 安静档的待机间隔（秒）。比活跃档更长 —— 没人在看，少动点。 */
const QUIET_GAP_MIN_SEC = 20;
const QUIET_GAP_MAX_SEC = 45;

/** 安静档里"这次用程序化小动作而不是动作文件"的概率。 */
const CLIP_CHANCE_QUIET = 0.5;
/** 活跃档同理，但更常播素材动作（素材动作更自然）。 */
const CLIP_CHANCE_ACTIVE = 0.2;

/** 一次性小动作，随机挑一个 */
const FIDGET_CLIPS: readonly Clip[] = [
  CLIPS.peek,
  CLIPS.shakeHead,
  CLIPS.hop,
  CLIPS.stretch,
];

export type IdlePlan =
  | { kind: 'motion'; group: 'idle' }
  | { kind: 'clip'; clip: Clip };

export class IdleDirector {
  /** 距上次排程过去了多久 */
  private timer = 0;
  private gap = 0;
  /** 距上次交互过去了多久 */
  private sinceInteraction = 0;
  private drowsy = false;
  /** 角色有没有待机动作文件。没有的话只能靠程序化动作撑着 */
  private idleMotionAvailable = true;

  constructor() {
    this.resetGap(ACTIVE_GAP_MIN_SEC, ACTIVE_GAP_MAX_SEC);
  }

  setIdleMotionAvailable(available: boolean): void {
    this.idleMotionAvailable = available;
  }

  /**
   * 用户做了点什么。
   *
   * @returns 该播的"惊醒"片段 —— 只有正在打瞌睡被打断时才非 null；
   *          大白天被摸一下不该先演一出刚睡醒。
   */
  noteInteraction(): Clip | null {
    const wasDrowsy = this.drowsy;
    this.sinceInteraction = 0;
    this.drowsy = false;
    // 交互之后重新计时：否则刚摸完她立刻又排一个待机动作，
    // "被摸的反应"会被自己的待机动作接走
    this.timer = 0;
    this.resetGap(ACTIVE_GAP_MIN_SEC, ACTIVE_GAP_MAX_SEC);
    return wasDrowsy ? CLIPS.startle : null;
  }

  /** 推进一帧。到点了返回该播什么，没到点返回 null。 */
  update(dt: number): IdlePlan | null {
    this.sinceInteraction += dt;

    // 冷落久了就打瞌睡 —— 这是一次**状态切换**，不是排程，
    // 所以它不看 timer：到了时间就该立刻开始点头
    if (!this.drowsy && this.sinceInteraction >= DROWSY_AFTER_SEC) {
      this.drowsy = true;
      return { kind: 'clip', clip: CLIPS.doze };
    }
    // 打瞌睡是个持续状态，期间的每帧都不再排别的
    if (this.drowsy) return null;

    this.timer += dt;
    if (this.timer < this.gap) return null;

    this.timer = 0;
    const quiet = this.sinceInteraction >= QUIET_AFTER_SEC;
    this.resetGap(
      quiet ? QUIET_GAP_MIN_SEC : ACTIVE_GAP_MIN_SEC,
      quiet ? QUIET_GAP_MAX_SEC : ACTIVE_GAP_MAX_SEC,
    );

    // 没有待机动作文件的角色只能靠程序化动作 —— 否则它会一动不动，
    // 而"一动不动"在桌宠上和"卡住了"长得一模一样
    if (!this.idleMotionAvailable) {
      return { kind: 'clip', clip: pick(FIDGET_CLIPS) };
    }

    const chance = quiet ? CLIP_CHANCE_QUIET : CLIP_CHANCE_ACTIVE;
    if (Math.random() < chance) {
      return { kind: 'clip', clip: pick(FIDGET_CLIPS) };
    }
    return { kind: 'motion', group: 'idle' };
  }

  private resetGap(min: number, max: number): void {
    // 固定间隔会被人看出节拍，随机一下才像"它自己想动一下"
    this.gap = min + Math.random() * (max - min);
  }
}

const pick = <T>(items: readonly T[]): T => {
  const item = items[Math.floor(Math.random() * items.length)];
  // 非空常量数组，越界只可能是索引算错 —— 真发生了也别崩在渲染循环里
  return (item ?? items[0]) as T;
};
