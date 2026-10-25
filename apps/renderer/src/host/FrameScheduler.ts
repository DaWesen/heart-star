/**
 * 帧调度
 *
 * 常驻应用的命门：用户会在任务管理器里看你的 CPU。
 * 目标 —— 空闲时 <1%，交互时 60fps。
 *
 * 策略：
 *  - 交互中：60fps
 *  - 空闲 N 秒后：降到 15fps（呼吸这类慢动作看不出差别）
 *  - 窗口被完全遮挡：暂停
 *
 * 例外：3D 的 IK 层必须保持 60fps 更新，
 * 降帧会让"伸手够鼠标"变得黏滞，手感立刻崩。
 *
 * 预算由壳层下发（见 bridge/ipc.ts）。本类只负责执行，不关心策略从哪来。
 */

/**
 * 调度器能接受的预算。刻意与协议里的 `FrameBudget` 区分开：
 * 协议是跨进程契约，这里是进程内的调度参数，两者形状不同不该同名，
 * 否则改协议时很容易误改到调度器。
 */
export type FrameRate = number | 'paused';

/** 帧统计上报周期。1s 一次，够看趋势又不至于刷屏。 */
const STATS_WINDOW_MS = 1000;

export class FrameScheduler {
  private target: FrameRate = 60;
  private lastFrame = 0;
  private accumulator = 0;
  private rafId: number | null = null;
  private running = false;

  private statsFrames = 0;
  private statsCostMs = 0;
  private statsWindowStart = 0;

  constructor(
    private readonly onFrame: (dt: number) => void,
    /** 每秒上报一次实测帧率与单帧耗时，供壳层验证降帧是否真的生效 */
    private readonly onStats?: (fps: number, frameMs: number) => void,
  ) {}

  setBudget(budget: FrameRate): void {
    this.target = budget;
    if (budget === 'paused') {
      this.stop();
    } else if (!this.running) {
      this.start();
    }
  }

  start(): void {
    if (this.running || this.target === 'paused') return;
    this.running = true;
    this.lastFrame = performance.now();
    this.statsWindowStart = this.lastFrame;
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private loop = (now: number): void => {
    if (!this.running) return;

    // lastFrame 必须**每帧**推进。原来只在真正出帧时才推进，
    // 于是 elapsed 变成"距上一次出帧"的累计值，累加器会把同一段时间重复计入，
    // 结果实际帧率远高于预算（实测预算 60 却跑出 100）。
    const elapsed = now - this.lastFrame;
    this.lastFrame = now;

    const interval = 1000 / (typeof this.target === 'number' ? this.target : 60);

    // 累积器：避免降帧时丢帧导致的动作跳变
    this.accumulator += elapsed;
    if (this.accumulator >= interval) {
      const dt = Math.min(this.accumulator / 1000, 0.1); // 夹紧，防止后台切回时的巨大 dt
      // 扣掉一个周期而不是清零：清零会丢掉不足一帧的余量，长期累积造成帧率漂移。
      // 再夹一层上限，防止长时间挂起后连续补帧把主循环压死。
      this.accumulator = Math.min(this.accumulator - interval, interval);

      const started = performance.now();
      this.onFrame(dt);
      this.statsCostMs += performance.now() - started;
      this.statsFrames += 1;
    }

    const windowMs = now - this.statsWindowStart;
    if (windowMs >= STATS_WINDOW_MS && this.statsFrames > 0) {
      this.onStats?.(
        (this.statsFrames * 1000) / windowMs,
        this.statsCostMs / this.statsFrames,
      );
      this.statsFrames = 0;
      this.statsCostMs = 0;
      this.statsWindowStart = now;
    }

    this.rafId = requestAnimationFrame(this.loop);
  };
}
