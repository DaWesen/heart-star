# 桃濑日和 —— 授权与署名

- 来源：Live2D 官方示例数据集（免费发布）
  <https://www.live2d.com/zh-CHS/learn/sample/momose-hiyori/>
- 插画：Kani Biimu ／ 模型：Live2D
- 原始授权说明见同目录 `ReadMe.txt`

## 条款要点（摘要，以官方原文为准）

- 分类：Live2D **原创角色**。
- 普通用户与小规模企业（年销售额 < 1000 万日元）在同意授权协议的前提下，
  可自由用于**商业与非商业**创作活动，含公开、分发、贩卖。
- 中/大规模企业仅限非公开的内部试用。
- 使用前须同意《无偿提供素材使用授权协议》与《Live2D Cubism 素材样本的使用授权要求》。
- **个别要求：必须完全保留该角色设计上的所有细节，不得做任何改变。**
  即不可改立绘、不可二次创作改形象。
- 不得用于损害角色形象的使用（色情、暴力、引起观众不适或误导观众等）。

## 必须展示的署名

产品内「关于」页等可编辑长文处，必须包含：

> 本作品的角色在运用株式会社Live2D的著作物素材样本时依据了株式会社Live2D规定的协议。本作品完全根据制作者的自我裁量制作而成。

空间受限时（如社交平台简介）：

> 本作品的角色中运用了株式会社Live2D的著作物素材样本。

实现位置：面板「关于」页（见 `docs/engineering-plan.md` §9）。

署名正文写在 manifest.json 的 `credits.attribution`，由壳层扫描角色目录时读出、
随角色列表下发给面板。放在角色包里而不是面板硬编码：署名跟着角色走，换角色就换，
不会出现"换了角色还挂着上一个角色的声明"那种错。
校验器对资产型角色按 **error** 要求它存在（缺一行声明，分发就是在违约）。

## 素材不入库

`runtime/` 目录（moc3 / 贴图 / 动作）**不进 git**，由美术另行分发，
原因见仓库根 `.gitignore`。本目录内只有 `manifest.json` / `NOTICE.md` / `ReadMe.txt` 入库。

## 未声明的语义

`joy` / `anger` / `sadness` 未写入 `manifest.json`：

本模型**不含表情文件（exp3.json）**。情绪应走 expressions 表而非裸参数，
硬把眉毛与嘴形参数凑成情绪映射只会得到扭曲的表情。
因此这三项在 `pnpm validate:characters` 时报 warning（可降级），属预期，不要为了消警告去填满它。

## 动作与语义组的对应

模型自带 7 个动作组，全部已挂到语义组上（见 `manifest.json` 的 `motions`）。
映射关系是按动作幅度推断的初版，**不是定稿**：

| 语义组 | 模型动作组 | 文件 |
| --- | --- | --- |
| `idle` | `Idle` | m01 / m02 / m05 |
| `tap_head` | `Tap` | m07 / m08 |
| `tap_body` | `Tap@Body` | m09 |
| `greet` | `FlickUp` | m06 |
| `emote_flustered`（慌一下） | `Flick` | m03 |
| `emote_shy`（低头） | `FlickDown` | m04 |
| `sleep`（打瞌睡） | `Flick@Body` | m10 |

`grab` / `drop` **没有**素材动作：素材里那两个（m03 / m04）幅度太小，
拖拽时窗口跟着鼠标走、相对运动为零，动作幅度再小就完全看不出来。
这两个组由渲染层**合成**（`ProceduralClip` 的 `grab` / `drop`）：
腿收起 + 身体后仰 + 手臂拉起，做成循环保持的"悬挂姿态"，松手才结束。
m03 / m04 留在 `emote_*` 里，可以在面板上点着对比。

模型组名（`Flick` 等）与语义组名（`grab` 等）对不上是常态 —— 组名是美术起的。
解析规则在渲染层 `Live2DAdapter.resolveMotion`：先按组名归一化匹配，
匹配不到就拿 manifest 里声明的动作文件去 model3 的组里反查。
**改映射只改 manifest 的 `motions` 表**，不要去改 `runtime/`（不入库）。

`tap_head` 的命中区没有手标（模型只标了胸口的 `HitArea`），
渲染层按"模型总高顶部 28%"做几何推断，见 `Live2DAdapter.hitsHeadBand`。
