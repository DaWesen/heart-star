#!/usr/bin/env tsx
/**
 * 角色包校验 CLI
 *
 * 用法：
 *   pnpm validate:characters assets/characters/<name>
 *   pnpm validate:characters assets/characters/<name> --json
 *
 * 设计要点：--json 输出机器可读，供 CI 在美术提交角色包时自动校验。
 * 退出码：有 error 为 1，仅 warning 为 0。
 */
import { validateCharacterDir, type Issue } from './validate.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('用法: validate <角色目录> [--json]');
  process.exit(2);
}

const result = await validateCharacterDir(target);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const errors = result.issues.filter((i: Issue) => i.level === 'error');
const warnings = result.issues.filter((i: Issue) => i.level === 'warning');

if (result.ok && result.issues.length === 0) {
  console.log(`✓ ${target} 校验通过`);
}

for (const i of errors) {
  console.error(`✗ [error]   ${i.code} @ ${i.path}\n           ${i.message}`);
}
for (const i of warnings) {
  console.warn(`! [warning] ${i.code} @ ${i.path}\n           ${i.message}`);
}

if (result.ok) {
  console.log(`\n${target}: 通过（${warnings.length} 条警告）`);
} else {
  console.error(`\n${target}: 失败（${errors.length} 个错误，${warnings.length} 条警告）`);
}

process.exit(result.ok ? 0 : 1);
