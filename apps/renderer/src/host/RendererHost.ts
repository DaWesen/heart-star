import type { CharacterManifest, RendererCapabilities } from '@heart-star/character-schema';
import type { PetForm } from '@heart-star/protocol';
import { loadManifest } from '../character/manifest';
import { CHARACTER_SCALE } from '@heart-star/protocol';
import type { CharacterRenderer } from '../renderer/CharacterRenderer';
import { createAdapter } from '../renderer/adapters';
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
  }

  /** 当前角色 id。角色切换完成前为 null。 */
  getCharacterId(): string | null {
    return this.characterId;
  }

  /** 按 id 切换角色：加载 manifest → 建 adapter → 换掉旧的。 */
  async switchCharacter(characterId: string): Promise<void> {
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
    this.renderer?.render(dt);
  }
}
