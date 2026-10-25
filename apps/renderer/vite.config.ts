import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** workspace 包直连源码，避免每次改动都要先打包依赖 */
const resolveWorkspace = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const CHARACTERS_SRC = resolveWorkspace('../../assets/characters');

/**
 * 让渲染层能 fetch 到 `/characters/<id>/manifest.json`。
 *
 * 角色包在仓库根的 assets/ 下，不在 renderer 的 vite root 里，
 * dev 与 build 都不会自动带上它。发布时角色包要走 Tauri 的 resource 机制
 * （M3「角色包从外部加载」），这里是让当前 dev 与构建能跑起来的过渡手段。
 *
 * 构建时**只拷 manifest.json**：moc3 与贴图是几 MB 级的，
 * 而渲染层此刻只用到 manifest 里的 kind / semantics，拷全量纯属浪费。
 */
function serveCharacters(): Plugin {
  let distDir = '';

  return {
    name: 'heart-star-characters',

    configResolved(config) {
      distDir = path.resolve(config.root, config.build.outDir ?? 'dist');
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/characters/')) return next();

        const rel = url.slice('/characters/'.length).split('?')[0] ?? '';
        const file = path.resolve(CHARACTERS_SRC, rel);
        // 目录穿越防护：解析后的路径必须仍在角色目录内。
        // 请求来自面板经壳层转发的 characterId，不能假设它一定干净。
        if (!file.startsWith(CHARACTERS_SRC) || !existsSync(file)) return next();

        res.setHeader(
          'Content-Type',
          file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
        );
        res.end(readFileSync(file));
      });
    },

    closeBundle() {
      if (!distDir || !existsSync(CHARACTERS_SRC)) return;

      for (const entry of readdirSync(CHARACTERS_SRC, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(CHARACTERS_SRC, entry.name, 'manifest.json');
        if (!existsSync(src)) continue;

        const dest = path.join(distDir, 'characters', entry.name);
        mkdirSync(dest, { recursive: true });
        copyFileSync(src, path.join(dest, 'manifest.json'));
      }
    },
  };
}

export default defineConfig({
  plugins: [serveCharacters()],
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
