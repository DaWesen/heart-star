import { IPC_CHANNELS } from '@heart-star/protocol';
import { RendererHost } from './host/RendererHost';
import { IpcBridge, TauriTransport } from './bridge/ipc';

/**
 * 渲染进程入口。
 *
 * 刻意不使用任何 UI 框架 —— 这是常驻进程，运行时开销必须极小，
 * 且窗口里除了角色什么都没有。
 */
const stage = document.getElementById('stage');
if (!stage) {
  throw new Error('缺少 #stage 容器');
}

const host = new RendererHost(stage);
const bridge = new IpcBridge(host);

// 只有跑在 Tauri 里才挂真实 transport。
// 纯 vite dev（浏览器直接开 5173）下没有 Tauri 全局对象，挂了会抛错，
// 而"不启动壳层就能调试渲染层"是刻意保留的能力。
if ('__TAURI_INTERNALS__' in window) {
  bridge.attach(
    new TauriTransport(IPC_CHANNELS.shellCommand, IPC_CHANNELS.rendererEvent),
  );
}

// M1 阶段先用占位角色验证窗口层（透明、穿透、形态切换、DPI）。
// 刻意不接 Live2D —— 排除渲染库的干扰变量，问题定位更快。
// 真实角色由壳层的 switchCharacter 命令触发加载（面板按钮 → 壳 → 这里）。
await host.usePlaceholder();

// 必须等角色加载完再 start：`ready` 事件要带上渲染能力，
// 而能力只有 adapter 实例化后才拿得到。壳层靠这条消息触发握手。
bridge.start();
