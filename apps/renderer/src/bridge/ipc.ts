import { listen, emit } from '@tauri-apps/api/event';
import type { ShellCommand, RendererEvent } from '@heart-star/protocol';
import type { RendererHost } from '../host/RendererHost';

/**
 * IPC 桥 —— 渲染进程与壳层的唯一通道
 *
 * 消息类型与通道名全部来自 packages/protocol，本文件不含任何自定义消息结构。
 *
 * transport 保留为抽象有两层意义：
 *  1. 纯 vite dev（不启动 Tauri）下不挂 transport，渲染层能独立跑起来调试；
 *  2. 测试时可注入内存实现，不必拉起整个壳。
 */
export interface Transport {
  onCommand(handler: (cmd: ShellCommand) => void): void;
  emit(event: RendererEvent): void;
}

/** 真实 transport：Tauri v2 的全局事件通道。 */
export class TauriTransport implements Transport {
  constructor(
    private readonly commandChannel: string,
    private readonly eventChannel: string,
  ) {}

  onCommand(handler: (cmd: ShellCommand) => void): void {
    // 刻意不保存 listen 返回的取消句柄：渲染进程的生命周期与页面完全一致，
    // 页面销毁时 Tauri 会连同监听器一起回收。留一个谁也不会去调的 unlisten，
    // 只是把"这里可能有泄漏"的错觉写进代码里。
    void listen<ShellCommand>(this.commandChannel, (event) => handler(event.payload)).catch(
      (e) => console.error('[heart-star] 监听壳层命令失败', e),
    );
  }

  emit(event: RendererEvent): void {
    void emit(this.eventChannel, event).catch((e) =>
      console.error('[heart-star] 上报渲染事件失败', e),
    );
  }
}

export class IpcBridge {
  private transport: Transport | null = null;

  constructor(private readonly host: RendererHost) {
    // 帧统计上抛给壳层。放在这里而不是 host 里，是因为"上报"是 IPC 职责，
    // 渲染宿主不该知道壳层存在。
    host.onStats = (fps, frameMs) =>
      this.emit({ type: 'frameStats', fps, frameMs });
  }

  /** 允许注入 transport，测试时可用内存实现替换 */
  attach(transport: Transport): void {
    this.transport = transport;
    transport.onCommand((cmd) => this.handle(cmd));
  }

  start(): void {
    if (this.transport) {
      // 壳层会在收到 ready 后补发初始状态（尺寸/形态/帧预算），
      // 所以这里不要自己设预算，否则会和壳层的策略打架
      const capabilities = this.host.getCapabilities();
      if (capabilities) {
        this.emit({ type: 'ready', capabilities });
      }
      return;
    }

    // 无 transport（纯前端 dev 模式）：直接开跑，便于独立调试渲染层
    this.host.setFrameBudget(60);
  }

  private handle(cmd: ShellCommand): void {
    switch (cmd.type) {
      case 'setForm':
        this.host.setForm(cmd.form);
        break;
      case 'setBounds':
        this.host.setBounds(cmd.width, cmd.height);
        break;
      case 'setFrameBudget':
        // 协议用判别联合（跨进程契约要能生成严格类型），
        // 调度器用进程内参数，形状不同，在这里转换
        this.host.setFrameBudget(cmd.budget.kind === 'paused' ? 'paused' : cmd.budget.value);
        break;
      case 'setGazeTarget':
        // TODO(M2): 交给 GazeController 平滑后写入 adapter.lookAt
        break;
      case 'switchCharacter':
        this.switchCharacter(cmd.characterId);
        break;
      case 'setCharacterScale':
        this.setCharacterScale(cmd.scale);
        break;
      case 'setInputMode':
        // 输入模式由壳层通过窗口样式实现，渲染层无需动作
        break;
    }
  }

  /**
   * 切换角色。
   *
   * 失败必须上报而不是静默：面板上的按钮点下去没有反馈，
   * 用户无从判断是"切换中"还是"压根没生效"。
   * 壳层会把这条错误转发给面板显示（见 ipc/panel.rs）。
   */
  private async switchCharacter(characterId: string): Promise<void> {
    try {
      await this.host.switchCharacter(characterId);
      this.emit({ type: 'characterSwitched', characterId });
    } catch (e) {
      this.emit({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
        fatal: false,
      });
    }
  }

  /**
   * 缩放当前角色。
   *
   * 事件里回传的是夹紧后的值：面板滑块拖到底时，它显示的数字必须和
   * 模型实际大小一致，否则用户会以为是延迟或丢事件。
   */
  private setCharacterScale(scale: number): void {
    const applied = this.host.setScale(scale);
    if (applied === null) return;

    const id = this.host.getCharacterId();
    if (id) {
      this.emit({ type: 'characterScaled', characterId: id, scale: applied });
    }
  }

  private emit(event: RendererEvent): void {
    this.transport?.emit(event);
  }
}
