/**
 * Cubism Core（live2dcubismcore.min.js）的按需加载与诊断。
 *
 * 为什么它不在 dependencies 里、也不在仓库里：
 * Live2D 的许可条款不允许把 Cubism SDK 本体随包再分发（工程计划 §11），
 * 它必须由使用者自己从 Live2D 官网下载后放进 `apps/renderer/vendor/`。
 *
 * 于是"缺 SDK"是**必然会发生在用户机器上**的常态，不是异常情况：
 * 报错信息必须直接告诉他去哪拿、放到哪，否则用户面对的只是一句
 * "角色加载失败"，无从下手。
 */

/** dev 与构建都由 vite 插件从 apps/renderer/vendor/ 提供 */
const CORE_URL = '/vendor/live2dcubismcore.min.js';

const MISSING_HINT =
  '缺少 Cubism Core：请从 Live2D 官网下载 Cubism SDK for Web，' +
  '把其中的 live2dcubismcore.min.js 放到 apps/renderer/vendor/ 下' +
  '（该目录的 README 有完整步骤）。SDK 本体不允许随包再分发，只能自行获取。';

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

let pending: Promise<void> | null = null;

/** 确保 window.Live2DCubismCore 就位。重复调用复用同一次加载。 */
export function ensureCubismCore(): Promise<void> {
  if (window.Live2DCubismCore) return Promise.resolve();

  pending ??= loadScript().then(() => {
    // 文件取到了却没挂上全局：多半放错了文件（比如放成了 framework 的 bundle，
    // 或者拿了 cubism2 的 core）。这里点明，避免用户对着一个"能加载但用不了"的
    // 黑盒反复重试。
    if (!window.Live2DCubismCore) {
      throw new Error(
        'Cubism Core 已下载但没有挂上 window.Live2DCubismCore —— ' +
          '放进 apps/renderer/vendor/ 的可能不是 SDK 里那个 live2dcubismcore.min.js。',
      );
    }
  });

  return pending;
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CORE_URL;
    script.async = false;

    script.onload = () => resolve();
    script.onerror = () => {
      // 失败就清掉缓存，否则用户补好文件后必须重启应用才生效
      pending = null;
      reject(new Error(MISSING_HINT));
    };

    document.head.appendChild(script);
  });
}
