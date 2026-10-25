import { emit, listen } from '@tauri-apps/api/event';
import { IPC_CHANNELS, type PanelCommand, type PanelEvent } from '@heart-star/protocol';

/**
 * 面板 ↔ 壳 的通道。
 *
 * 面板**不直接对渲染层说话**：渲染层只认壳这一个命令来源。
 * 角色切换由面板发请求 → 壳转发 → 渲染执行 → 壳把结果回传面板。
 */
export type OnCommand = (cmd: PanelCommand) => void;

export function bindPanelIpc(onCommand: OnCommand): () => void {
  let disposed = false;

  void listen<PanelCommand>(IPC_CHANNELS.panelCommand, (event) => {
    if (!disposed) onCommand(event.payload);
  }).catch((e) => console.error('[heart-star] 监听壳层命令失败', e));

  // 壳层在收到 ready 后才会补发角色列表 —— 页面加载时的消息会全部丢失，
  // 所以初始状态一律由这里主动要，而不是等壳层推。
  sendPanelEvent({ type: 'ready' });

  return () => {
    disposed = true;
  };
}

export function sendPanelEvent(event: PanelEvent): void {
  void emit(IPC_CHANNELS.panelEvent, event).catch((e) =>
    console.error('[heart-star] 上报面板事件失败', e),
  );
}
