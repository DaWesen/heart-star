import type {
  CharacterManifest,
  RendererCapabilities,
  SemanticParam,
  SemanticArea,
  SemanticBone,
} from '@heart-star/character-schema';
import type { CharacterRenderer, MotionRequest } from '../CharacterRenderer';
import { CHARACTER_SCALE } from '@heart-star/protocol';

/**
 * 占位角色 —— M1 专用
 *
 * 存在的理由：M1 要验证的是透明、穿透、形态切换、DPI 这些窗口层难题。
 * 此时接 Live2D 只会引入干扰变量，问题定位变慢。
 * 用一个会动的方块把窗口层所有问题暴露出来，是最快的路径。
 *
 * 刻意不依赖 PixiJS：纯 DOM 实现，零依赖，启动即用。
 */

/** 方块占画布的比例。画布是 320×420，正好落回 120×160。 */
const BLOCK_WIDTH_RATIO = 0.375;
const BLOCK_HEIGHT_RATIO = 0.38;

export class PlaceholderAdapter implements CharacterRenderer {
  readonly kind = 'sprite' as const;

  readonly capabilities: RendererCapabilities = {
    proceduralPose: false,
    ik: false,
    additiveLayer: false,
    physics: 'none',
  };

  private readonly node: HTMLElement;
  private readonly eyeNode: HTMLElement;

  private elapsed = 0;
  private gazeX = 0;
  private gazeY = 0;
  private lipSync = 0;
  private width = 320;
  private height = 420;
  private userScale: number = CHARACTER_SCALE.default;

  constructor(private readonly container: HTMLElement) {
    this.node = document.createElement('div');
    Object.assign(this.node.style, {
      position: 'absolute',
      left: '50%',
      bottom: '0',
      transform: 'translateX(-50%)',
      // 由 RendererHost 按角色 id 注入（见 RendererHost.tintFor）。
      // 没有注入时退回粉色 —— 纯 vite dev 直接开页面时就是这个色。
      background: 'var(--character-tint, #ff8fb1)',
      borderRadius: '24px',
      transformOrigin: 'bottom center',
    } satisfies Partial<CSSStyleDeclaration>);

    // 眼睛：用于验证 gaze 与 lipSync 是否真的生效
    this.eyeNode = document.createElement('div');
    Object.assign(this.eyeNode.style, {
      position: 'absolute',
      top: '30%',
      left: '50%',
      width: '16px',
      height: '16px',
      background: '#2b2b2b',
      borderRadius: '50%',
    } satisfies Partial<CSSStyleDeclaration>);
    this.node.appendChild(this.eyeNode);

    this.container.appendChild(this.node);
    this.applyBounds();
  }

  async load(_manifest: CharacterManifest): Promise<void> {
    // 占位角色无需资产
  }

  playMotion(_req: MotionRequest): void {
    // 占位：M1 不实现动作
  }

  setExpression(_id: string): void {
    // 占位
  }

  setParameter(semantic: SemanticParam, value: number): void {
    // 占位角色只响应 lipSync，用于验证口型链路是否打通
    if (semantic === 'lipSync') {
      this.lipSync = value;
    }
  }

  lookAt(nx: number, ny: number): void {
    this.gazeX = nx;
    this.gazeY = ny;
  }

  hitTest(_x: number, _y: number): SemanticArea | null {
    return 'body';
  }

  setBounds(width: number, height: number): void {
    // 只接受有限正值：壳层在窗口尚未落位时可能下发 0，
    // 拿 0 去算尺寸会让方块整个消失，看起来像渲染崩了。
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width <= 0 || height <= 0) return;

    this.width = width;
    this.height = height;
    this.applyBounds();
  }

  setScale(scale: number): void {
    this.userScale = Math.min(
      CHARACTER_SCALE.max,
      Math.max(CHARACTER_SCALE.min, scale),
    );
    this.applyBounds();
  }

  render(dt: number): void {
    this.elapsed += dt;

    // 呼吸与口型都作用在 transform 上，必须合成一次再写入。
    // 分开写的话后写的会把先写的整个覆盖掉，表现为"呼吸的时候嘴不动"。
    const breath = Math.sin(this.elapsed * 1.6) * 0.02;
    const mouth = 1 + this.lipSync * 0.05;
    this.node.style.transform = `translateX(-50%) scale(${1 + breath}) scaleY(${mouth})`;

    // 视线：眼睛位移，验证 GazeController → lookAt 链路
    this.eyeNode.style.transform = `translate(${this.gazeX * 18}px, ${this.gazeY * 10}px)`;
  }

  dispose(): void {
    this.node.remove();
  }

  getBoneHandle(_bone: SemanticBone) {
    return null;
  }

  /**
   * 方块尺寸跟着画布走。
   * 这样壳层握手下发的 CSS 尺寸对不对，肉眼一眼就能看出来 ——
   * 尺寸错了方块会明显偏大或偏小，而这是 DPI 换算最容易出问题的地方。
   */
  private applyBounds(): void {
    this.node.style.width = `${Math.round(this.width * BLOCK_WIDTH_RATIO * this.userScale)}px`;
    this.node.style.height = `${Math.round(this.height * BLOCK_HEIGHT_RATIO * this.userScale)}px`;
  }
}
