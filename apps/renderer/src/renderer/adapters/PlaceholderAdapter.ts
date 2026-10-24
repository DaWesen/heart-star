import type { CharacterManifest, RendererCapabilities, SemanticParam, SemanticArea, SemanticBone } from '@heart-star/character-schema';
import type { CharacterRenderer, MotionRequest } from '../CharacterRenderer';

/**
 * 占位角色 —— M1 专用
 *
 * 存在的理由：M1 要验证的是透明、穿透、形态切换、DPI 这些窗口层难题。
 * 此时接 Live2D 只会引入干扰变量，问题定位变慢。
 * 用一个会动的方块把窗口层所有问题暴露出来，是最快的路径。
 *
 * 刻意不依赖 PixiJS：纯 DOM 实现，零依赖，启动即用。
 */
export class PlaceholderAdapter implements CharacterRenderer {
  readonly kind = 'sprite' as const;

  readonly capabilities: RendererCapabilities = {
    proceduralPose: false,
    ik: false,
    additiveLayer: false,
    physics: 'none',
  };

  private readonly node: HTMLElement;
  private elapsed = 0;
  private gazeX = 0;
  private gazeY = 0;
  private width = 300;
  private height = 400;

  constructor(private readonly container: HTMLElement) {
    this.node = document.createElement('div');
    Object.assign(this.node.style, {
      position: 'absolute',
      left: '50%',
      bottom: '0',
      transform: 'translateX(-50%)',
      width: '120px',
      height: '160px',
      background: '#ff8fb1',
      borderRadius: '24px',
      transformOrigin: 'bottom center',
    } satisfies Partial<CSSStyleDeclaration>);

    // 眼睛：用于验证 gaze 与 lipSync 是否真的生效
    const eye = document.createElement('div');
    Object.assign(eye.style, {
      position: 'absolute',
      top: '48px',
      left: '50%',
      width: '16px',
      height: '16px',
      background: '#2b2b2b',
      borderRadius: '50%',
    } satisfies Partial<CSSStyleDeclaration>);
    this.node.appendChild(eye);
    this.eyeNode = eye;

    this.container.appendChild(this.node);
  }

  private readonly eyeNode: HTMLElement;

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
      this.node.style.transform = `translateX(-50%) scaleY(${1 + value * 0.05})`;
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
    this.width = width;
    this.height = height;
  }

  render(dt: number): void {
    this.elapsed += dt;

    // 呼吸：正弦缩放。用来肉眼确认帧调度真的在跑、降帧有没有生效
    const breath = Math.sin(this.elapsed * 1.6) * 0.02;
    this.node.style.transform = `translateX(-50%) scale(${1 + breath})`;

    // 视线：眼睛位移，验证 GazeController → lookAt 链路
    this.eyeNode.style.transform = `translate(${this.gazeX * 18}px, ${this.gazeY * 10}px)`;

    void this.width;
    void this.height;
  }

  dispose(): void {
    this.node.remove();
  }

  getBoneHandle(_bone: SemanticBone) {
    return null;
  }
}
