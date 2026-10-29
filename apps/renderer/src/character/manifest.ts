import { CharacterManifestSchema, type CharacterManifest } from '@heart-star/character-schema';

/**
 * 角色 id 的白名单。
 *
 * characterId 从面板经壳层传来，最终会拼进 URL 去 fetch。
 * 不校验的话 `../../` 这类 id 能读到角色目录之外的文件。
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 加载角色 manifest。
 *
 * `/characters/` 这个路径由 renderer 的 vite 配置提供：角色包在仓库根的
 * assets/ 下，不在 renderer 的 vite root 里，dev 与 build 都不会自动带上它。
 * 发布时角色包要走 Tauri 的 resource 机制（M3「角色包从外部加载」）。
 */
export async function loadManifest(characterId: string): Promise<CharacterManifest> {
  if (!SAFE_ID.test(characterId)) {
    throw new Error(`角色 id 不合法：${characterId}`);
  }

  const url = `/characters/${characterId}/manifest.json`;
  // no-store 是必须的：manifest 是我们改得最勤的文件（动作映射、语义表
  // 都在它身上），而 WebView2 的 HTTP 缓存跨进程存活 ——
  // 不禁的话改完 manifest 重启应用，渲染层读到的还是上一次的旧表，
  // 新加的语义全部静默失效，没有任何报错可循。
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`角色 manifest 加载失败（HTTP ${res.status}）：${characterId}`);
  }

  // 必须走 schema 校验而不是直接断言类型：manifest 是外部数据，
  // 字段缺失不会在编译期暴露，只会让 adapter 在运行时拿到 undefined 然后崩在很深处。
  const parsed = CharacterManifestSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`角色 manifest 校验失败：${characterId}`);
  }

  if (parsed.data.id !== characterId) {
    throw new Error(`角色 id 与 manifest 不一致：请求 ${characterId}，实为 ${parsed.data.id}`);
  }

  return parsed.data;
}
