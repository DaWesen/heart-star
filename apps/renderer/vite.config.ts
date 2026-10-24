import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** workspace 包直连源码，避免每次改动都要先打包依赖 */
const resolveWorkspace = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@heart-star/character-schema': resolveWorkspace(
        '../../packages/character-schema/src/index.ts',
      ),
      '@heart-star/protocol': resolveWorkspace('../../packages/protocol/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // 分包刻意不写 manualChunks：
    // adapters/index.ts 里的动态 import 会让 Vite 自动为每个 adapter
    // 生成独立 chunk，只装 2D 角色的用户自然不会下载 three.js。
    // 预先声明 manualChunks 反而会在 adapter 尚未接入时产出空 chunk。
  },
  server: { port: 5173, strictPort: true },
});
