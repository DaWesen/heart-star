import type { ShellCommand, RendererEvent } from '@heart-star/protocol';
import type { RendererHost } from '../host/RendererHost';

/**
 * IPC 桥 —— 渲染进程与壳层的唯一通道
 *
 * 消息类型全部来自 packages/protocol，本文件不含任何自定义消息结构。
 *
 * TODO(M1)：接入 @tauri-apps/api 的 Channel / listen。
 * 骨架阶段保留 transport 抽象，便于在不启动 Tauri 的情况下单测本进程逻辑。
 */
export interface Transport {
  onCommand(handler: (cmd: ShellCommand) => void): void;
  emit(event: RendererEvent): void;
}

export class IpcBridge {
  private transport: Transport | null = null;

  constructor(private readonly host: RendererHost) {}

  /** 允许注入 transport，测试时可用内存实现替换 */
  attach(transport: Transport): void {
    this.transport = transport;
    transport.onCommand((cmd) => this.handle(cmd));
  }

  start(): void {
    // 无 transport 时（纯前端 dev 模式）直接开跑，便于独立调试渲染层
    if (!this.transport) {
      this.host.setFrameBudget(60);
      return;
    }
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
        this.host.setFrameBudget(cmd.fps);
        break;
      case 'setGazeTarget':
        // TODO(M2): 交给 GazeController 平滑后写入 adapter.lookAt
        break;
      case 'switchCharacter':
        // TODO(M2): 按 id 读取角色包并 loadCharacter
        break;
      case 'setInputMode':
        // 输入模式由壳层通过窗口样式实现，渲染层无需动作
        break;
    }
  }

  private emit(event: RendererEvent): void {
    this.transport?.emit(event);
  }
}
