import type { CharacterKind } from '@heart-star/character-schema';
import type { CharacterRenderer } from '../CharacterRenderer';

/**
 * Adapter 工厂 —— 懒加载分发的唯一入口。
 *
 * 每个 kind 走独立动态 import，Vite 自动分包。
 * 这是"只装 2D 角色的用户不下载 three.js"的实现点。
 */
export async function createAdapter(
  kind: CharacterKind,
  container: HTMLElement,
): Promise<CharacterRenderer> {
  switch (kind) {
    case 'sprite': {
      const { PlaceholderAdapter } = await import('./PlaceholderAdapter');
      return new PlaceholderAdapter(container);
    }

    case 'live2d':
      // M2：PixiJS v7 + pixi-live2d-display + Cubism 5 Web SDK
      throw new Error('Live2D adapter 于 M2 实现');

    case 'vrm':
      // M5：three.js + @pixiv/three-vrm
      throw new Error('VRM adapter 于 M5 实现');

    case 'spine':
      throw new Error('Spine adapter 未在首发计划内');

    default: {
      const never: never = kind;
      throw new Error(`未知角色类型: ${String(never)}`);
    }
  }
}
