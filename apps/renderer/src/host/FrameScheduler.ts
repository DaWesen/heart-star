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
 */
export type FrameBudget = number | 'paused';

export class FrameScheduler {
  private target: FrameBudget = 60;
  private lastFrame = 0;
  private accumulator = 0;
  private rafId: number | null = null;
  private running = false;

  constructor(private readonly onFrame: (dt: number) => void) {}

  setBudget(budget: FrameBudget): void {
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

    const elapsed = now - this.lastFrame;
    const interval = 1000 / (typeof this.target === 'number' ? this.target : 60);

    // 累积器：避免降帧时丢帧导致的动作跳变
    this.accumulator += elapsed;
    if (this.accumulator >= interval) {
      this.lastFrame = now;
      const dt = Math.min(this.accumulator / 1000, 0.1); // 夹紧，防止后台切回时的巨大 dt
      this.accumulator = 0;
      this.onFrame(dt);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };
}
