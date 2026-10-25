/**
 * 同时启动两个前端的 dev server。
 *
 * 两个前端必须分开跑：renderer 与 panel 是两个独立的 vite root，
 * Tauri 的两个窗口各自加载一个地址（5173 / 5174）。
 *
 * 直接跑 vite 的 JS 入口而不是 `pnpm exec vite`：
 * Windows 下 `pnpm.cmd` 是批处理，用 `shell: false` spawn 会失败，
 * 而开 shell 又会吃掉子进程的退出码。
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { label: 'renderer', dir: 'apps/renderer', port: 5173 },
  { label: 'panel', dir: 'apps/panel', port: 5174 },
];

let shuttingDown = false;
const children = [];

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const { label, dir, port } of targets) {
  const cwd = path.join(repoRoot, dir);
  const entry = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');

  if (!existsSync(entry)) {
    console.error(`[dev] ${label}: 找不到 ${entry}，请先 pnpm install`);
    shutdown(1);
  }

  console.error(`[dev] 启动 ${label} → http://localhost:${port}/ (${dir})`);
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  children.push(child);

  child.on('error', (err) => {
    console.error(`[dev] ${label} 无法启动: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    // 任一前端挂掉就整体退出：留一个半死的 dev server 只会让问题更难查
    console.error(`[dev] ${label} 退出（code=${code} signal=${signal}）`);
    shutdown(code ?? 1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}
