import type { CharacterManifest, SemanticParam } from '@heart-star/character-schema';
import { REQUIRED_PARAMS } from '@heart-star/character-schema';

/**
 * 语义降级
 *
 * 集中处理"这个角色不具备某项语义能力"的情况。
 *
 * 为什么单独成模块而不是散落在 adapter 里：
 * 降级策略是产品决策，散落实现会导致两年后没人说得清
 * "为什么这个角色看起来呆滞"——答案是它缺了 breath 参数，但没人记得。
 *
 * 已达成的约定（见工程方案附录 B）：
 *   lookX / lookY / lipSync —— 核心必填，缺失即构建期失败，运行期不降级
 *   breath / blink / joy / anger / sadness —— 可选，缺失时静默降级
 */
export class SemanticFallback {
  constructor(private readonly manifest: CharacterManifest) {}

  has(param: SemanticParam): boolean {
    return this.manifest.semantics[param] !== undefined;
  }

  isRequired(param: SemanticParam): boolean {
    return (REQUIRED_PARAMS as readonly string[]).includes(param);
  }

  /**
   * 把一次语义写入请求解析为可执行动作。
   * 返回 null 表示跳过（无替代方案）。
   */
  resolve(param: SemanticParam, value: number): { param: SemanticParam; value: number } | null {
    if (this.has(param)) return { param, value };

    // 情绪类缺失 → 退化到表情切换（由 adapter 用 expressions 表兜底）
    if (param === 'joy' || param === 'anger' || param === 'sadness') {
      return null; // adapter 应改走 setExpression
    }

    // 呼吸与眨眼：没有就直接不做，硬凑反而更像故障
    return null;
  }
}
