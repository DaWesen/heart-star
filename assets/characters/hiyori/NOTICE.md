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

实现位置：M3 的「关于」页（见 `docs/engineering-plan.md` §9）。在此之前，
分发版本必须至少有一处可见的上述声明。

## 素材不入库

`runtime/` 目录（moc3 / 贴图 / 动作）**不进 git**，由美术另行分发，
原因见仓库根 `.gitignore`。本目录内只有 `manifest.json` / `NOTICE.md` / `ReadMe.txt` 入库。

## 未声明的语义

`joy` / `anger` / `sadness` 未写入 `manifest.json`：

本模型**不含表情文件（exp3.json）**。情绪应走 expressions 表而非裸参数，
硬把眉毛与嘴形参数凑成情绪映射只会得到扭曲的表情。
因此这三项在 `pnpm validate:characters` 时报 warning（可降级），属预期，不要为了消警告去填满它。

## 未使用的动作

模型自带的 `Flick` / `FlickDown` / `FlickUp` / `Tap` / `Flick@Body` 组未写入 manifest，
因为 `MOTION_GROUPS` 尚无对应语义（`idle` / `greet` / `sleep` / `wake` 与 `tap_<area>`）。
等语义字典在 M2 定稿后再决定要不要加"挥开"这类组。
