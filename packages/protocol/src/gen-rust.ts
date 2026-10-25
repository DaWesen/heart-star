#!/usr/bin/env tsx
/**
 * 由 TS 契约生成 Rust 侧的 serde 结构。
 *
 * 为什么必须有这一步：架构约定协议**禁止手写镜像**——手写必然与 TS 侧
 * 不同步，而不同步的表现是消息静默丢弃，极难定位。所以 Rust 侧一律生成。
 *
 * 用法：pnpm --filter @heart-star/protocol gen:rust
 * 产物：apps/desktop/src-tauri/src/ipc/generated.rs（入库，CI 校验无漂移）
 *
 * 输出按类型名字母序排列，保证同样的输入永远得到同样的字节，
 * 这样 CI 才能用 git diff 判断"契约改了但没重新生成"。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGenerator } from 'ts-json-schema-generator';

import { IPC_CHANNELS } from './index.js';

/**
 * 只读关心这些字段，所以自己声明最小结构，不用库自带的 `JSONSchema7`。
 * 后者把 `anyOf` 元素定义成 `JSONSchema7Definition = JSONSchema7 | boolean`，
 * 每读一处都要收窄，全是噪音。
 */
interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  items?: Schema;
  definitions?: Record<string, Schema>;
}

/** 需要生成到 Rust 的契约根类型。其余定义会被它们间接引入，一并生成。 */
const ROOTS = ['ShellCommand', 'RendererEvent'] as const;

// 本文件位于 packages/protocol/src/，故上溯三级到仓库根
const OUT_PATH = fileURLToPath(
  new URL('../../../apps/desktop/src-tauri/src/ipc/generated.rs', import.meta.url),
);

// ---------- JSON Schema → Rust ----------

/** `number`（TS 的 number 是双精度）与 `integer` 分开映射，避免句柄被截断。 */
const PRIMITIVES: Record<string, string> = {
  string: 'String',
  number: 'f64',
  integer: 'i64',
  boolean: 'bool',
};

const FALLBACK_TYPE = 'serde_json::Value';

function isObjectSchema(s: Schema): boolean {
  return s.type === 'object' && s.properties !== undefined;
}

/** 判别式字段名候选。TS 侧统一用 `type`（消息）或 `kind`（形态）。 */
function findDiscriminant(variants: Schema[]): string | null {
  if (!variants.every(isObjectSchema)) return null;

  const constKeys = variants.map((v) => {
    const props = v.properties ?? {};
    return Object.keys(props).filter((k) => typeof props[k]?.const === 'string');
  });
  const first = constKeys[0];
  if (!first || first.length === 0) return null;
  if (constKeys.some((keys) => keys.length === 0)) return null;

  const shared = first.filter((key) => constKeys.every((keys) => keys.includes(key)));
  const tag = shared[0];
  if (!tag) return null;

  // 判别式必须能区分各变体，否则不是判别联合
  const values = variants.map((v) => String(v.properties?.[tag]?.const));
  return new Set(values).size === variants.length ? tag : null;
}

function isNullable(schema: Schema): boolean {
  if (Array.isArray(schema.type)) return schema.type.includes('null');
  if (schema.anyOf) return schema.anyOf.some((s) => s.type === 'null');
  return false;
}

/** 剥掉 `T | null`，返回内层类型。 */
function unwrapNullable(schema: Schema): Schema {
  if (schema.anyOf) {
    const inner = schema.anyOf.filter((s) => s.type !== 'null');
    const only = inner[0];
    if (inner.length === 1 && only) return only;
  }
  return schema;
}

function typeName(schema: Schema): string {
  if (schema.$ref) return schema.$ref.replace('#/definitions/', '');

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== 'null');
    const single = nonNull[0];
    if (nonNull.length === 1 && single) return PRIMITIVES[single] ?? FALLBACK_TYPE;
    return FALLBACK_TYPE;
  }

  if (schema.type === 'array') {
    return `Vec<${schema.items ? typeName(schema.items) : FALLBACK_TYPE}>`;
  }

  return PRIMITIVES[schema.type ?? ''] ?? FALLBACK_TYPE;
}

function toPascalCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toSnakeCase(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function docComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  // JSDoc 段落可能是多行的。Rust 的 `///` 必须**每行都有前缀**，
  // 漏了续行前缀就不是注释而是代码，直接编译失败。
  return (
    description
      .split('\n')
      .map((line) => `${indent}/// ${line.trim()}`)
      .join('\n') + '\n'
  );
}

/**
 * @param isStructField 结构体字段要写 `pub`；枚举变体字段**不能**写 ——
 *   变体字段的可见性继承枚举本身，写 `pub` 是编译错误（E0449）。
 */
function fieldLines(
  properties: Record<string, Schema>,
  required: string[] | undefined,
  indent: string,
  isStructField: boolean,
): string {
  const requiredSet = new Set(required ?? []);
  let out = '';

  for (const [rawName, schema] of Object.entries(properties)) {
    const nullable = isNullable(schema);
    const base = typeName(unwrapNullable(schema));
    // 缺失即 Option；显式 `| null` 也用 Option，但必须保留 null 的序列化
    const ty = nullable || !requiredSet.has(rawName) ? `Option<${base}>` : base;

    out += docComment(schema.description, indent);
    if (!requiredSet.has(rawName)) {
      out += `${indent}#[serde(default)]\n`;
    }
    if (!requiredSet.has(rawName) && !nullable) {
      out += `${indent}#[serde(skip_serializing_if = "Option::is_none")]\n`;
    }
    out += `${indent}#[serde(rename = "${rawName}")]\n`;
    out += `${indent}${isStructField ? 'pub ' : ''}${toSnakeCase(rawName)}: ${ty},\n`;
  }
  return out;
}

/** 把一个 JSON Schema 定义转成 Rust 类型定义。 */
function emit(name: string, schema: Schema): string {
  let out = docComment(schema.description, '');

  // 1. 字符串字面量联合 → 简单枚举
  if (schema.enum && schema.type === 'string') {
    out += '#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]\n';
    out += `pub enum ${name} {\n`;
    for (const value of schema.enum) {
      const tagValue = String(value);
      out += `    #[serde(rename = "${tagValue}")]\n`;
      out += `    ${toPascalCase(tagValue)},\n`;
    }
    out += '}\n';
    return out;
  }

  // 2. 判别联合 → serde 内部标签枚举
  if (schema.anyOf) {
    const tag = findDiscriminant(schema.anyOf);
    if (tag) {
      out += '#[derive(Debug, Clone, Serialize, Deserialize)]\n';
      out += `#[serde(tag = "${tag}")]\n`;
      out += `pub enum ${name} {\n`;
      for (const variant of schema.anyOf) {
        const tagValue = String(variant.properties?.[tag]?.const);
        const rest: Record<string, Schema> = { ...variant.properties };
        delete rest[tag];

        out += `    #[serde(rename = "${tagValue}")]\n`;
        out += `    ${toPascalCase(tagValue)}`;
        if (Object.keys(rest).length > 0) {
          out += ' {\n';
          out += fieldLines(rest, variant.required, '        ', false);
          // 结构体变体后面必须带逗号，否则下一个变体的属性会被当成语法错误
          out += '    },\n';
        } else {
          out += ',\n';
        }
      }
      out += '}\n';
      return out;
    }
  }

  // 3. 普通对象 → 结构体
  if (isObjectSchema(schema)) {
    out += '#[derive(Debug, Clone, Serialize, Deserialize)]\n';
    out += `pub struct ${name} {\n`;
    out += fieldLines(schema.properties ?? {}, schema.required, '    ', true);
    out += '}\n';
    return out;
  }

  throw new Error(`无法为 ${name} 生成 Rust 类型：暂不支持的 schema 形状`);
}

// ---------- 主流程 ----------

const generator = createGenerator({
  path: fileURLToPath(new URL('./index.ts', import.meta.url)),
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  // 跳过类型检查：本文件只是读 AST，且 character-schema 在生成期未必已构建
  skipTypeCheck: true,
});

const definitions: Record<string, Schema> = {};
for (const root of ROOTS) {
  const schema = generator.createSchema(root) as unknown as Schema;
  Object.assign(definitions, schema.definitions ?? {});
}

const typeNames = Object.keys(definitions).sort();

let rust = `//! 由 packages/protocol 生成 —— **请勿手改**
//!
//! 修改消息结构请改 packages/protocol/src/index.ts，然后执行：
//!   pnpm --filter @heart-star/protocol gen:rust
//!
//! 生成规则：TS 字面量联合 → Rust 枚举（带 serde rename）；
//! 判别联合 → serde 内部标签枚举；对象 → 结构体。
//! 输出按类型名字母序排列，保证生成结果可复现（CI 靠 git diff 校验无漂移）。
//!
//! 已知取舍：内联（未具名）的字面量联合退化为 String ——
//! 例如 RendererCapabilities.physics。等 character-schema 也纳入生成后消除。

use serde::{Deserialize, Serialize};

/// IPC 通道名 —— 与 TS 侧同源，禁止在 Rust 里另写一份字符串
pub const CHANNEL_SHELL_COMMAND: &str = "${IPC_CHANNELS.shellCommand}";
pub const CHANNEL_RENDERER_EVENT: &str = "${IPC_CHANNELS.rendererEvent}";
`;

for (const name of typeNames) {
  const definition = definitions[name];
  if (!definition) continue;
  rust += '\n' + emit(name, definition);
}

writeFileSync(OUT_PATH, rust, 'utf8');
console.log(`✓ 已生成 ${OUT_PATH}`);
console.log(`  类型：${typeNames.join(', ')}`);
