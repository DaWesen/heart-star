import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const resolveWorkspace = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
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
    // 面板产物必须落在 renderer 的 dist **之内**：
    // Tauri 的 frontendDist 只能指向一个目录，两个前端共用一个 dist 就得靠子路径区分。
    // 代价是构建顺序有依赖 —— 根 package.json 的 build 脚本显式先 renderer 后 panel，
    // 否则 renderer 的 emptyOutDir 会把面板产物一起清掉。
    outDir: '../renderer/dist/panel',
    // 子路径下必须用相对基址，否则资源会指向 dist 根而非 dist/panel
    base: './',
    sourcemap: true,
    emptyOutDir: true,
  },
  server: { port: 5174, strictPort: true },
});
