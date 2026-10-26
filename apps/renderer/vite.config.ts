import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

/** workspace 包直连源码，避免每次改动都要先打包依赖 */
const resolveWorkspace = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const CHARACTERS_SRC = resolveWorkspace('../../assets/characters');
/** Cubism SDK 本体放这里。不入库（许可不允许再分发），dev 从本地读。 */
const VENDOR_SRC = resolveWorkspace('vendor');

/** 常见资源后缀 → MIME。贴图必须给对类型，否则 Pixi 会把它当二进制拒绝解码。 */
const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const mimeOf = (file: string): string =>
  MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * dev 下把仓库外的目录挂到 URL 前缀上。
 *
 * 两个用途：
 *  1. `/characters/<id>/…` —— 角色包在仓库根的 assets/ 下，不在 renderer 的
 *     vite root 里。dev 要能取到 moc3 / 贴图 / 动作，构建时只拷 manifest
 *     （见下），发布形态另走 Tauri resource 机制（M3「角色包从外部加载」）。
 *  2. `/vendor/…` —— Cubism Core。它不许随包再分发，只能从本地目录读。
 *
 * 两个前缀都做了目录穿越防护：路径来自 URL，不能假设干净。
 */
function serveOutsideRoot(root: string, prefix: string) {
  return (req: { url?: string }, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (!url.startsWith(prefix)) return next();

    const rel = url.slice(prefix.length).split('?')[0] ?? '';
    const file = path.resolve(root, rel);

    // 穿越或文件不存在都直接 404，不能 return next()：
    // 否则请求会漏到 Vite 的 SPA 兜底，拿到 200 + index.html，
    // 而 Cubism Core 的缺失诊断正是靠"取不到"来触发的 —— 拿到一段 HTML
    // 会让报错变成"文件在但没挂上全局"，把用户引到错误的排查方向。
    if (!file.startsWith(root) || !existsSync(file)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    res.setHeader('Content-Type', mimeOf(file));
    res.end(readFileSync(file));
  };
}

function serveCharacters(): Plugin {
  let distDir = '';

  return {
    name: 'heart-star-characters',

    configResolved(config) {
      distDir = path.resolve(config.root, config.build.outDir ?? 'dist');
    },

    configureServer(server) {
      server.middlewares.use(serveOutsideRoot(CHARACTERS_SRC, '/characters/'));
      server.middlewares.use(serveOutsideRoot(VENDOR_SRC, '/vendor/'));
    },

    // 构建时**只拷 manifest.json**：
    // dev 是直接从 assets/ 读整个角色包的，构建产物不这么做——
    // moc3 与贴图是几 MB 级，塞进前端产物既臃肿又不利于分发。
    // 发布形态的角色资产走 Tauri resource 机制（M3「角色包从外部加载」），
    // 到时这里会改成拷贝全量或直接打包。
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
