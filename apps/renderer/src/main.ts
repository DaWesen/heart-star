import { RendererHost } from './host/RendererHost';
import { IpcBridge } from './bridge/ipc';

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

bridge.start();

// TODO(M1)：从壳层接收 switchCharacter 命令后加载真实角色包。
// M1 阶段先用占位角色验证窗口层（透明、穿透、形态切换、DPI），
// 刻意不接 Live2D —— 排除渲染库的干扰变量，问题定位更快。
await host.usePlaceholder();
