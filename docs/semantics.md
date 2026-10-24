# 语义字典（跨团队评审稿）

> 状态：待评审。**M2 之前必须冻结。**
> 一旦冻结，2D 与 3D 两条资产管线同时受它约束。

## 这份文档为什么存在

2D（Live2D 参数）与 3D（VRM 骨骼）在底层毫无共同点。让上层行为逻辑同时适配两套是不可能的——除非中间有一层双方都遵守的语义。

**这份字典就是那一层。** 它定义了"桌宠能表达什么"，而不是"用什么技术实现"。改它等于改全产品的能力边界，任何增删都需跨团队评审。

## 语义参数

| 语义参数 | 含义 | 必填 | Live2D 示例 | VRM 示例 |
|---|---|---|---|---|
| `lookX` / `lookY` | 视线方向（−1..1） | **是** | `ParamAngleX/Y` | LookAt 骨骼旋转 |
| `lipSync` | 口型开合 | **是** | `ParamMouthOpenY` | Viseme 混合形状 |
| `breath` | 呼吸幅度 | 否 | `ParamBreath` | 胸腔骨骼 / SpringBone |
| `blink` | 眨眼 | 否 | `ParamEyeLOpen/ROpen` | Expression `blink` |
| `joy` | 喜悦强度 | 否 | 表情参数混合 | VRM Expression 权重 |
| `anger` | 愤怒强度 | 否 | 同上 | 同上 |
| `sadness` | 悲伤强度 | 否 | 同上 | 同上 |

**必填的依据**：眼动与口型是桌宠"活着"的底线，不做降级。缺失即构建期失败（`character-schema` CLI 报 error）。

**可选项的处理**：缺失时由 `SemanticFallback` 静默降级，报 warning 不阻断。降级策略集中在那一个模块里，不得散落到各 adapter。

## 语义部位

| 部位 | 用途 | 2D 实现 | 3D 实现 |
|---|---|---|---|
| `head` | 拍头反馈 | Drawable | 包围盒 / mesh |
| `body` | 抚摸、抱起 | Drawable | 包围盒 / mesh |
| `hand` | 牵手、递物 | Drawable | 包围盒 |

判定必须收敛到这三个语义，不允许 adapter 各自返回模型内部名称。

## 动作组

| 组 | 用途 | 必需 |
|---|---|---|
| `idle` | 空闲循环 | 强烈建议 |
| `greet` | 启动 / 唤醒问候 | 建议 |
| `sleep` / `wake` | 休眠与唤醒 | 可选 |
| `tap_<area>` | 部位点击反馈（如 `tap_head`） | 可选 |
| `emote_<emotion>` | 情绪表达（如 `emote_joy`） | 可选 |

## 骨骼语义（3D）

`head` `neck` `chest` `spine` `hip` `upperArmL/R` `lowerArmL/R` `handL/R`

- VRM 1.0 自带标准人形骨骼命名，可省略映射
- MMD / Mixamo / Blender 导出的 glTF **必须**在 `manifest.rig.bones` 里逐个映射

## 能力协商

上层查询 `capabilities`（能做什么），**不判断** `kind`（是什么）：

| 能力 | 含义 |
|---|---|
| `proceduralPose` | 能否程序化摆姿势 |
| `ik` | 能否做反向动力学 |
| `additiveLayer` | 是否支持加性动画层 |
| `physics` | `builtin`（Live2D）/ `springbone`（VRM）/ `none` |

禁止在业务层写 `if (kind === 'vrm')`——那会让 3D 能力升级时上层要跟着改。

## 变更流程

1. 提议方说明：新增/删除什么语义，影响哪条管线
2. 评估：已交付角色包是否需要回填（这是主要成本）
3. 冻结后同步更新：`packages/character-schema/src/semantics.ts`、`manifest.ts`、本文档
4. 旧角色包跑一遍 CLI，确认是否产生新的 error
