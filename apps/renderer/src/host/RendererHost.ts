import type { CharacterManifest, RendererCapabilities } from '@heart-star/character-schema';
import type { PetForm } from '@heart-star/protocol';
import type { CharacterRenderer } from '../renderer/CharacterRenderer';
import { createAdapter } from '../renderer/adapters';
import { FrameScheduler, type FrameBudget } from './FrameScheduler';

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
  private form: PetForm = { kind: 'desktop' };
  private capabilities: RendererCapabilities | null = null;

  constructor(private readonly element: HTMLElement) {
    this.scheduler = new FrameScheduler((dt) => this.tick(dt));
  }

  getCapabilities(): RendererCapabilities | null {
    return this.capabilities;
  }

  /** 加载角色。会完整 dispose 旧实例 —— 同一时刻只允许一个 adapter 存活。 */
  async loadCharacter(manifest: CharacterManifest): Promise<void> {
    this.renderer?.dispose();
    this.renderer = null;

    // 动态 import 是刻意的：Vite 会把它切成独立 chunk，
    // 只装 2D 角色的用户永远不下载 three.js
    const adapter = await createAdapter(manifest.kind, this.element);
    await adapter.load(manifest);

    this.renderer = adapter;
    this.capabilities = adapter.capabilities;
  }

  /** M1 占位角色：会动的方块，用于验证窗口层而不引入渲染库干扰变量 */
  async usePlaceholder(): Promise<void> {
    this.renderer?.dispose();
    this.renderer = null;

    const { PlaceholderAdapter } = await import('../renderer/adapters/PlaceholderAdapter');
    const adapter = new PlaceholderAdapter(this.element);
    this.renderer = adapter;
    this.capabilities = adapter.capabilities;
    this.scheduler.start();
  }

  setForm(form: PetForm): void {
    this.form = form;
    // 两个形态下 root 都保持透明，差异交由壳层的窗口层级（Z 序）处理
    this.element.dataset.form = form.kind;
    void this.form;
  }

  setFrameBudget(budget: FrameBudget): void {
    this.scheduler.setBudget(budget);
  }

  setBounds(width: number, height: number): void {
    this.renderer?.setBounds(width, height);
  }

  private tick(dt: number): void {
    this.renderer?.render(dt);
  }
}
