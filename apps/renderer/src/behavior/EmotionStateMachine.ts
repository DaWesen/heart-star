import { isEmotionParam, type EmotionParam, type SemanticParam } from '@heart-star/character-schema';

/**
 * 情绪状态机
 *
 * 输入：AI 语义标签中的 emotion
 * 输出：语义参数强度（0..1），交由 adapter 映射到实际参数/骨骼
 *
 * 刻意只输出**语义**，不输出参数名 —— 参数名属于 manifest 的职责。
 * 情绪集合取自语义字典（EMOTION_PARAMS），不在这里另立一套。
 */
export class EmotionStateMachine {
  private current: EmotionParam | 'neutral' = 'neutral';
  private intensity = 0;
  /** 衰减速率：情绪不应骤然消失，否则表情切换很生硬 */
  private readonly decayPerSecond = 0.6;

  apply(emotion: string | undefined): void {
    if (!emotion) return;
    // 只允许语义字典内的情绪通过，其余视为 neutral
    this.current = isEmotionParam(emotion) ? emotion : 'neutral';
    this.intensity = 1;
  }

  tick(dt: number): void {
    this.intensity = Math.max(0, this.intensity - this.decayPerSecond * dt);
    if (this.intensity === 0) {
      this.current = 'neutral';
    }
  }

  /** 供渲染层消费的语义输出 */
  sample(): { param: SemanticParam; value: number } | null {
    if (this.current === 'neutral' || this.intensity === 0) return null;
    return { param: this.current, value: this.intensity };
  }
}
