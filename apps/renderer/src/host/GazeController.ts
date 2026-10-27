/**
 * 视线平滑
 *
 * 为什么不把目标值直接写进 adapter：指针是每秒上百次的离散输入，
 * 直接跟随的话角色的眼睛是"跳"过去的，像被电了一下。
 * 指数平滑给出的是"转头看过去"的过程 —— 这才有活物的感觉。
 *
 * 用时间常数而不是"每帧走 10%"的写法：后者在不同帧率下速度不一样，
 * 而本项目的帧率是动态的（空闲降帧），按帧推进会让视线在降帧后变慢。
 */
export class GazeController {
  private targetX = 0;
  private targetY = 0;
  private x = 0;
  private y = 0;

  /**
   * @param tau 时间常数（秒）。越小跟得越紧。
   *   0.12 是"看得出来在动，又不显得神经质"的手感值。
   */
  constructor(private readonly tau: number = 0.12) {}

  /** 设置目标方向（-1..1，超出会被夹紧）。 */
  setTarget(nx: number, ny: number): void {
    this.targetX = clampSigned(nx);
    this.targetY = clampSigned(ny);
  }

  /** 回到正视。指针离开、切换形态时用。 */
  reset(): void {
    this.targetX = 0;
    this.targetY = 0;
  }

  /** 推进一步，返回本帧应当写入的视线方向。dt 单位秒。 */
  update(dt: number): { x: number; y: number } {
    // dt 为 0（两帧挤在同一毫秒）时 k 也是 0，不会推进也不会出错
    const k = 1 - Math.exp(-Math.max(dt, 0) / this.tau);
    this.x += (this.targetX - this.x) * k;
    this.y += (this.targetY - this.y) * k;
    return { x: this.x, y: this.y };
  }
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
