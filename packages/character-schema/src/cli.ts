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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCharacterDir, type Issue } from './validate.js';

/**
 * 向上找仓库根，以 `pnpm-workspace.yaml` 为标记。
 *
 * 不用写死的 `../../` 级数：那在脚本被移动或包结构调整后会静默算错，
 * 表现为"路径少一级"这种极难一眼看出的问题。
 */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const raw = args.find((a) => !a.startsWith('--'));

if (!raw) {
  console.error('用法: validate <角色目录> [--json]');
  process.exit(2);
}

// 相对路径按**仓库根**解析，而不是进程 cwd。
// 本脚本由根 package.json 经 `pnpm --filter` 调用，此时 cwd 是包目录而非仓库根，
// 按 cwd 解析会让用法里写的 `assets/characters/<name>` 永远找不到东西。
const target = path.isAbsolute(raw) ? raw : path.resolve(findRepoRoot(), raw);

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
