import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
  CharacterManifestSchema,
  SEMANTIC_BONE_SET,
  type CharacterManifest,
} from './manifest.js';
import { REQUIRED_PARAMS, OPTIONAL_PARAMS, type SemanticParam } from './semantics.js';

export interface Issue {
  level: 'error' | 'warning';
  /** 问题代码，便于 CI 精确过滤 */
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  manifest?: CharacterManifest;
}

/**
 * 校验 manifest 对象。
 * error   —— 阻断：缺核心字段、结构与 kind 不符
 * warning —— 放行：语义缺失（可降级）、覆盖不全（体验受损但不崩）
 */
export function validateManifest(input: unknown): ValidationResult {
  const issues: Issue[] = [];
  const parsed = CharacterManifestSchema.safeParse(input);

  if (!parsed.success) {
    for (const e of parsed.error.issues) {
      issues.push({
        level: 'error',
        code: 'SCHEMA',
        path: e.path.join('.'),
        message: e.message,
      });
    }
    return { ok: false, issues };
  }

  const m = parsed.data;

  // —— 语义参数检查（仅资产型角色）——
  // semantics 映射的是模型里的参数名；程序化角色（entry 省略，如 M1 占位方块）
  // 根本没有参数可映射，对它要求 lookX/lookY 等于要求它声明不存在的东西。
  if (m.entry) {
    // 核心语义必填（error）
    for (const p of REQUIRED_PARAMS) {
      if (!m.semantics[p]) {
        issues.push({
          level: 'error',
          code: 'SEMANTIC_REQUIRED_MISSING',
          path: `semantics.${p}`,
          message: `核心语义参数 ${p} 缺失。眼动与口型是桌宠"活着"的底线，不做降级。`,
        });
      }
    }

    // 可选语义缺失（warning），由 SemanticFallback 静默降级
    for (const p of OPTIONAL_PARAMS as readonly SemanticParam[]) {
      if (!m.semantics[p]) {
        issues.push({
          level: 'warning',
          code: 'SEMANTIC_OPTIONAL_MISSING',
          path: `semantics.${p}`,
          message: `可选语义参数 ${p} 未声明，相关表现将被降级。`,
        });
      }
    }
  }

  // —— 3D 必须有 rig ——
  // 理由：lookX/lookY 已属必填，而 3D 实现眼动依赖头颈骨骼，无 rig 则必填项无法兑现。
  if (m.kind === 'vrm' && (m.rig.type === 'none' || !m.rig.bones['head'])) {
    issues.push({
      level: 'error',
      code: 'RIG_REQUIRED_FOR_3D',
      path: 'rig',
      message: '3D 角色必须声明 rig.bones.head，否则必填的 lookX/lookY 无法实现。',
    });
  }

  // —— 未知骨骼语义键（warning）——
  for (const key of Object.keys(m.rig.bones)) {
    if (!SEMANTIC_BONE_SET.has(key)) {
      issues.push({
        level: 'warning',
        code: 'RIG_UNKNOWN_BONE',
        path: `rig.bones.${key}`,
        message: `骨骼语义 "${key}" 不在标准集合中。若为扩展骨骼请忽略；若属拼写错误请修正。`,
      });
    }
  }

  // —— 命中区域覆盖（warning）——
  if (!m.hitAreas['head']) {
    issues.push({
      level: 'warning',
      code: 'HITAREA_HEAD_MISSING',
      path: 'hitAreas.head',
      message: '未定义 head 命中区域，拍头交互将不可用。',
    });
  }

  // —— 空闲动作（warning）——
  if (!m.motions['idle']?.length) {
    issues.push({
      level: 'warning',
      code: 'MOTION_IDLE_EMPTY',
      path: 'motions.idle',
      message: '无 idle 动作组，角色空闲时不会有任何动作。',
    });
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    manifest: m,
  };
}

/** 校验角色目录：manifest + 入口文件是否真实存在 */
export async function validateCharacterDir(dir: string): Promise<ValidationResult> {
  const manifestPath = path.join(dir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          code: 'MANIFEST_NOT_FOUND',
          path: manifestPath,
          message: '目录下未找到 manifest.json',
        },
      ],
    };
  }

  // 剥离 UTF-8 BOM：美术常在 Windows 上用记事本编辑 manifest.json，
  // 带 BOM 会让 JSON.parse 直接失败。不能指望所有提交者都懂编码，
  // 在入口处容错比事后排查便宜得多。
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          code: 'MANIFEST_INVALID_JSON',
          path: manifestPath,
          message: `JSON 解析失败：${(e as Error).message}`,
        },
      ],
    };
  }

  const result = validateManifest(json);

  // 入口文件存在性 —— 只在 manifest 结构正确后才检查。
  // 程序化角色（如 M1 占位方块）没有资产入口，entry 可省略，跳过这项检查。
  if (result.manifest?.entry) {
    const entryPath = path.join(dir, result.manifest.entry);
    try {
      await access(entryPath);
    } catch {
      result.issues.push({
        level: 'error',
        code: 'ENTRY_NOT_FOUND',
        path: result.manifest.entry,
        message: 'manifest.entry 指向的文件不存在',
      });
      result.ok = false;
    }
  }

  return result;
}
