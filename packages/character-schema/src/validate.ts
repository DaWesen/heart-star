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
      message:
        '未定义 head 命中区域，拍头将退化为几何推断（模型上部一段）。能标就标，标了才准。',
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

/**
 * model3.json 里用得到的部分。
 *
 * 只声明要读的字段：完整结构随 Cubism 版本漂移，全量引入反而脆。
 * 另注：`Parameters` 是**可选**的 —— 不少模型（日和就是）不在 model3 里导出
 * 参数表，参数列表只存在于 moc3 二进制里，那时参数名无从校验。
 */
interface Model3File {
  FileReferences?: {
    Moc?: string;
    Motions?: Record<string, ({ File?: string } | undefined)[] | undefined> | undefined;
    Expressions?: ({ Name?: string; File?: string } | undefined)[] | undefined;
  };
  Parameters?: ({ Id?: string } | undefined)[] | undefined;
  Drawables?: ({ Id?: string } | undefined)[] | undefined;
  HitAreas?: ({ Id?: string } | undefined)[] | undefined;
}

/** 取路径末段并归一（小写、两种分隔符都认）。 */
function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] ?? p).toLowerCase();
}

const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/**
 * 把 moc3 里所有可打印 ASCII 串拼成一个大字符串，用于"某个参数名是否出现过"的
 * 包含判定。
 *
 * 拼成一个串而不是收集成集合：参数 ID 常是更长标识符的片段，切成 token 后
 * 精确相等会查不到。判定用 `includes`，代价是可能误命中 —— 所以调用方只
 * 把它当 warning，不能当 error。
 */
async function readMocStrings(mocPath: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(mocPath);
  } catch {
    return null;
  }
  // latin1 保证每个字节映射到一个码点，不会被当成多字节 UTF-8 而截断
  return buf.toString('latin1');
}

/**
 * manifest 与模型文件的交叉校验。
 *
 * 为什么必须有这一层：manifest 是手写的，而它与模型对不上时**运行时全部静默** ——
 * 参数名不存在则写值被跳过（"做了动作没反应"）、动作文件名对不上则反查不到槽位
 * （不播）、命中区 drawable 不存在则永远命中不了。三者的表现都是"没反应"、
 * 都不报错，靠运行时排查一轮要花掉好几个小时。而这些在构建期读一遍 model3.json
 * 就能查出来。
 *
 * 只在能查的时候才判缺失：模型没导出参数表时，没出现在表里**不代表**参数不存在，
 * 那时报缺失就是在冤枉人。所以参数名校验在无 `Parameters` 时整体跳过并说明原因。
 */
async function crossCheckModel(dir: string, m: CharacterManifest, issues: Issue[]): Promise<void> {
  if (m.kind !== 'live2d' || !m.entry || !m.entry.toLowerCase().endsWith('.model3.json')) {
    return;
  }

  const entryPath = path.join(dir, m.entry);
  let raw: string;
  try {
    raw = await readFile(entryPath, 'utf8');
  } catch {
    // 入口读不到已经在上面报过 ENTRY_NOT_FOUND，这里别重复报
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let model: Model3File;
  try {
    model = JSON.parse(raw) as Model3File;
  } catch (e) {
    issues.push({
      level: 'error',
      code: 'MODEL_INVALID_JSON',
      path: m.entry,
      message: `模型文件 JSON 解析失败，无法交叉校验：${(e as Error).message}`,
    });
    return;
  }

  // model3 里的相对路径都以它自己所在目录为基准（日和是 runtime/…），
  // 而 manifest 的 entry 是以角色目录为基准的 —— 两者基准不同，别混用
  const modelDir = path.dirname(entryPath);

  // —— 动作文件 ——
  // 建立"末段名 → 模型里的真实路径"：运行时正是按末段名反查槽位的，
  // 用真实路径再去查磁盘，manifest 与模型写法不一致也不会误判
  const motionPaths = new Map<string, string>();
  for (const entries of Object.values(model.FileReferences?.Motions ?? {})) {
    for (const e of entries ?? []) {
      if (e?.File) motionPaths.set(baseName(e.File), e.File);
    }
  }

  for (const [group, files] of Object.entries(m.motions)) {
    for (const file of files ?? []) {
      const real = motionPaths.get(baseName(file));
      if (!real) {
        issues.push({
          level: 'error',
          code: 'MOTION_NOT_IN_MODEL',
          path: `motions.${group}`,
          message: `动作文件 ${file} 不在模型的动作表里。运行时反查不到槽位，这个动作**不会播**，且不报错。`,
        });
        continue;
      }
      try {
        await access(path.join(modelDir, real));
      } catch {
        issues.push({
          level: 'error',
          code: 'MOTION_FILE_MISSING',
          path: `motions.${group}`,
          message: `动作文件 ${real} 在磁盘上不存在（相对模型文件目录 ${path.relative(dir, modelDir) || '.'}）`,
        });
      }
    }
  }

  // —— 命中区的 drawable ——
  // HitAreas[].Id 本身就是 drawable 名，与 Drawables[].Id 同源
  const drawableIds = new Set<string>();
  for (const d of model.Drawables ?? []) {
    if (d?.Id) drawableIds.add(d.Id);
  }
  for (const h of model.HitAreas ?? []) {
    if (h?.Id) drawableIds.add(h.Id);
  }
  if (drawableIds.size > 0) {
    for (const [area, def] of Object.entries(m.hitAreas)) {
      if (def.type !== 'drawable') continue;
      if (!drawableIds.has(def.target)) {
        issues.push({
          level: 'error',
          code: 'HITAREA_TARGET_NOT_IN_MODEL',
          path: `hitAreas.${area}`,
          message: `命中区指向的 drawable "${def.target}" 不在模型里，这一部位**永远命中不了**。`,
        });
      }
    }
  }

  // —— 语义参数名 ——
  const paramIds = new Set<string>();
  for (const p of model.Parameters ?? []) {
    if (p?.Id) paramIds.add(p.Id);
  }
  if (paramIds.size > 0) {
    for (const [semantic, target] of Object.entries(m.semantics)) {
      for (const name of asArray(target)) {
        if (!paramIds.has(name)) {
          issues.push({
            level: 'error',
            code: 'SEMANTIC_PARAM_NOT_IN_MODEL',
            path: `semantics.${semantic}`,
            message: `参数 "${name}" 不在模型的参数表里，写值会被静默跳过 —— 表现为"做了动作没反应"。`,
          });
        }
      }
    }
  } else {
    // 降级：参数 ID 是以字符串形式存在 moc3 里的，扫一遍二进制就能大致确认
    // 名字在不在。比什么都不查强得多 —— 参数名写错是这类 manifest 里最难查的
    // 一类（写值被静默跳过，画面毫无变化）。
    //
    // 只给 warning 不给 error：这是启发式，名字可能是更长标识符的一部分、
    // 也可能被别的段引用，判定存在与否都不绝对，报 error 会冤枉人。
    const mocFile = model.FileReferences?.Moc;
    const haystack = mocFile ? await readMocStrings(path.join(modelDir, mocFile)) : null;

    if (!haystack) {
      issues.push({
        level: 'warning',
        code: 'MODEL_PARAM_TABLE_MISSING',
        path: m.entry,
        message:
          '模型未导出参数表（model3 无 Parameters，moc3 也读不到），参数名无法校验。' +
          '若写了模型里不存在的参数名，写值会被静默跳过且不报错，只能靠运行时排查。',
      });
    } else {
      for (const [semantic, target] of Object.entries(m.semantics)) {
        for (const name of asArray(target)) {
          if (!haystack.includes(name)) {
            issues.push({
              level: 'warning',
              code: 'SEMANTIC_PARAM_NOT_IN_MOC',
              path: `semantics.${semantic}`,
              message: `在模型二进制里找不到参数名 "${name}"（启发式判定）。` +
                '若它确实不存在，写值会被静默跳过，表现为"做了动作没反应"。',
            });
          }
        }
      }
    }
  }

  // —— 表情 ——
  const expNames = new Set<string>();
  for (const e of model.FileReferences?.Expressions ?? []) {
    if (e?.Name) expNames.add(e.Name);
  }
  if (expNames.size > 0) {
    for (const [id, file] of Object.entries(m.expressions ?? {})) {
      const name = baseName(file).replace(/\.exp3?\.json$/i, '');
      if (!expNames.has(name)) {
        issues.push({
          level: 'error',
          code: 'EXPRESSION_NOT_IN_MODEL',
          path: `expressions.${id}`,
          message: `表情 "${name}" 不在模型的表情表里（渲染层按文件名推名字），这个表情播不出来。`,
        });
      }
    }
  }
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

    // 署名：用了别人的素材就得把声明展示出来，这是素材方的条款，不是可选项。
    // 资产型角色（有 entry）缺它按 error 拦 —— 缺这一行，分发就是在违约，
    // 而且它没有任何运行时代价可提示（画面一切正常），只能在这里发现。
    if (!result.manifest.credits?.attribution) {
      result.issues.push({
        level: 'error',
        code: 'CREDITS_MISSING',
        path: 'credits.attribution',
        message:
          '资产型角色必须带 credits.attribution（素材方要求展示的署名正文）。' +
          '「关于」页靠它展示声明，缺了就是缺了素材方的署名。',
      });
      result.ok = false;
    }

    // 与模型文件对一遍：manifest 与模型对不上时运行时一律静默失效，
    // 这类问题只能在这里拦住
    await crossCheckModel(dir, result.manifest, result.issues);
    if (result.issues.some((i) => i.level === 'error')) {
      result.ok = false;
    }
  }

  return result;
}
