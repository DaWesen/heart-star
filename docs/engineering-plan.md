# Heart Star 工程方案

> 状态：草案 v0.1，待评审
> 日期：2026-10-25
> 范围：Windows 首发（macOS 二期），2D（Live2D）首发角色线，3D（VRM）为后续角色线
>
> **许可证基准**：仓库根 `LICENSE` 为 **PolyForm Noncommercial 1.0.0**。
> 本方案全文以"**非商业项目**"为前提 —— 涉及第三方资产授权、代码签名、功能范围的表述
> 均不得假设会商业化。若日后转为商业发布，§11 与 §8 需整体重做。

---

## 0. 一页纸摘要

Heart Star 是一款常驻桌面的 AI 桌宠产品。技术上的核心挑战不在 AI，而在**桌面窗口系统**：逐像素透明、鼠标穿透、双形态宿主切换、常驻资源占用。因此架构的第一原则是——**把窗口能力交给原生层（Rust/Win32），把渲染与内容交给 Web 层，把智能交给独立侧车进程**。三者通过明确接口解耦，使 3D 角色线在未来只需替换一个渲染 Adapter，不触碰壳层与 AI 层。

---

## 1. 产品形态

### 1.1 双形态窗口

| 形态 | 触发条件 | 表现 |
|---|---|---|
| **面板形态** | 用户打开管理面板 | 桌宠"生活"在面板内的房间场景中，可与之互动、拖拽、被前景家具遮挡 |
| **桌面形态** | 面板关闭/最小化 | 桌宠成为独立透明无边框窗口，浮于桌面，鼠标穿透，悬停可交互，可自由拖拽 |

两个形态**共享同一个渲染实例**，通过宿主窗口迁移实现无缝切换，宠物的动作、情绪、动画进度在切换中保持连续。

### 1.2 角色路线

- 2D（Live2D）与 3D（VRM）是**两条独立的角色线**，不是同一角色的切换开关
- `kind` 是角色的固有属性，渲染后端按角色**懒加载**：只装 2D 角色的用户永不加载 three.js，反之亦然
- 两条管线的唯一交点是**语义字典**与**manifest 结构**

### 1.3 功能范围（MVP）

- 角色渲染与物理摇曳、鼠标跟随、空闲动作调度
- 点击/拖拽交互，部位语义反馈（头/身体/手）
- LLM 对话 + 长期记忆
- 语音全链路（VAD → ASR → LLM → TTS）
- 设置面板：角色管理、人设、语音、快捷键
- 自动更新与崩溃恢复

> MVP 功能范围刻意不含**订阅/付费**：本项目按 PolyForm Noncommercial 发布（见 §11），
> 任何收费功能都与许可证冲突。若未来要做订阅，必须先换掉代码许可证。

---

## 2. 约束与非功能需求

### 2.1 性能预算（硬指标）

| 指标 | 目标 | 备注 |
|---|---|---|
| 空闲 CPU | < 1% | 无交互 N 秒后降帧至 12–15fps |
| 交互时帧率 | 60fps（集显可降级至 30fps） | |
| 常驻内存（2D） | 60–120MB | 全进程合计 |
| 常驻内存（3D） | 150–250MB | 单个 VRM 角色 |
| 冷启动到可见 | < 1.5s | 开机自启场景 |
| 形态切换耗时 | < 300ms，无闪烁 | |
| 语音唤醒到首字 | < 800ms | 流式 + 预连接 |
| 72 小时内存增长 | < 10% | soak test 门槛 |

### 2.2 兼容性矩阵

- Windows 10 21H2+ / Windows 11 全版本
- 缩放率 100% / 125% / 150% / 200%
- 多显示器混合 DPI
- 集显（Intel UHD / AMD Vega）必须可运行，作为最低配置档

---

## 3. 技术选型

### 3.1 选型结论

| 层 | 选型 | 关键理由 |
|---|---|---|
| 窗口壳 | **Tauri 2 (Rust)** | 常驻内存低、Win32 API 完全可控 |
| 面板 UI | React + Vite + TypeScript | 独立窗口进程，与渲染隔离 |
| 2D 渲染 | **PixiJS v7 + pixi-live2d-display** | v7 是 Live2D 插件官方稳定支持版本 |
| 2D 运行时 | **Cubism 5 SDK for Web** | 物理与表情最成熟 |
| 3D 渲染 | **three.js（WebGL2）+ three-vrm** | VRM 官方 Web 参考实现 |
| AI 侧车 | **Rust 独立进程** | 与渲染进程故障隔离 |
| 存储 | SQLite + sqlite-vec | 单文件，无需外部服务 |
| 更新 | tauri-plugin-updater + 主进程看门狗 | |
| 打包 | NSIS / WiX，代码签名（**非 EV**） | 降低 SmartScreen 拦截率；EV 需组织主体验证，非商业个人主体不具备申请条件，见 §11 |

### 3.2 关键决策记录（ADR 摘要）

| # | 决策 | 否决方案 | 否决理由 | 本决策的代价 |
|---|---|---|---|---|
| A1 | Tauri 2 而非 Electron | Electron | 常驻内存 200–400MB，包体大，启动慢 | 需 Rust 能力（团队具备） |
| A2 | 不用 Unity | Unity | 常驻 300–500MB、启动 3–8s、**官方不支持逐像素透明窗口** | 3D 内容上限较低，画质保守 |
| A3 | 不用 Godot 4（首发） | Godot 4 | 面板 UI 与 Web 生态弱；当前以 2D 为主，优势不显著 | 3D 变重时需重评 |
| A4 | PixiJS v7 而非 v8 | PixiJS v8 | Live2D 插件在 v8 仍为社区分支 | 非最新主版本 |
| A5 | 单实例宿主迁移 | 双实例 / 浮窗伪嵌入 | 双实例动作断档；伪嵌入跟随抖动、无法做前景遮挡 | 需自行处理 `SetParent` 复杂度 |
| A6 | 2D/3D 为不同角色线 | 同角色可切换 | 两种观感天然不同，用户对比会产生负面体验 | 两条资产管线并行 |
| A7 | 渲染后端懒加载 | 全部打包 | 常驻内存与启动时间浪费 | 需维护动态 import 分包 |
| A8 | WebGL2 首发，WebGPU 后置 | 直接 WebGPU | three-vrm 在 WebGPU 后端兼容性未广泛验证 | 需保留后端可切换抽象 |

---

## 4. 系统架构

### 4.1 进程模型

```
┌─ 主进程（Tauri 2 / Rust）────────────────────────────────┐
│ 窗口管理 · 形态切换 · 鼠标钩子 · 托盘 · 快捷键            │
│ 更新 · 看门狗 · 遥测 · 本地数据库                         │
└──────────────────────────────────────────────────────────┘
     │ 创建并持有                │ 创建并持有
┌─ 渲染进程 ───────────┐   ┌─ 面板进程 ──────────────────┐
│ WebView2（透明窗口）  │   │ WebView2（常规窗口）        │
│ RendererHost         │   │ 背景层 / 前景层 WebView      │
│  └ CharacterRenderer │   │ React UI                    │
│     ├ Live2DAdapter  │   └──────────────────────────────┘
│     ├ VrmAdapter     │
│     └ SpriteAdapter  │   ┌─ AI 侧车进程（Rust）─────────┐
│ 行为层：情感状态机    │   │ LLM 编排 · 记忆检索          │
│ 物理 · 跟随 · 降帧    │   │ VAD · ASR · TTS             │
└──────────────────────┘   └──────────────────────────────┘
     └────────── IPC：Tauri 事件 + 本地 socket ───────────┘
```

**进程隔离是硬要求**：渲染进程崩溃不得带走面板，面板崩溃宠物必须自动回收到桌面形态。

### 4.2 分层职责

| 层 | 职责 | 禁止 |
|---|---|---|
| 壳层（Rust） | 窗口、系统交互、生命周期 | 不感知角色种类与内容 |
| 渲染层 | 角色渲染、动作、物理、命中检测 | 不直接调用 Win32 |
| 行为层 | 情感状态机、空闲调度、语义参数驱动 | 不感知 2D/3D 实现 |
| AI 层 | 对话、记忆、语音 | 不感知渲染 |
| 面板层 | 用户配置与内容运营 | 不承担宠物逻辑 |

### 4.3 仓库结构

```
heart-star/
├─ LICENSE
├─ docs/
│  ├─ engineering-plan.md        # 本文档
│  └─ semantics.md               # 语义字典（跨团队评审稿）
├─ apps/
│  ├─ desktop/                  # Tauri 2 壳
│  │  ├─ src-tauri/
│  │  │  ├─ src/
│  │  │  │  ├─ window/           # 透明 · 穿透 · 钩子 · 形态切换 · DPI
│  │  │  │  ├─ ipc/
│  │  │  │  ├─ lifecycle/        # 看门狗 · 自启 · 托盘
│  │  │  │  └─ main.rs
│  │  │  ├─ capabilities/
│  │  │  └─ tauri.conf.json
│  │  └─ package.json
│  ├─ renderer/                  # 宠物渲染（Vite + TS，无框架）
│  │  └─ src/
│  │     ├─ host/                # canvas 管理 · 帧调度 · 降帧
│  │     ├─ renderer/            # CharacterRenderer + adapters/{live2d,vrm,sprite}
│  │     ├─ behavior/            # 情感状态机 · 空闲调度 · 跟随
│  │     └─ bridge/              # IPC 客户端
│  └─ panel/                     # 设置面板（React + Vite）
├─ packages/
│  ├─ character-schema/          # manifest 类型 + zod schema + 校验 CLI
│  ├─ protocol/                  # IPC 消息类型（壳 ↔ 渲染 ↔ AI）
│  └─ ai-core/                   # Rust：记忆 · 检索 · ASR/TTS · LLM 编排
└─ assets/characters/
   ├─ <name>.live2d/             # model3.json + motions + manifest.json
   └─ <name>.vrm/                # model.vrm + manifest.json
```

### 4.4 IPC 协议要点

- 命令方向：壳 → 渲染（`setMode` / `setInputMode` / `setBounds` / `switchCharacter`）
- 事件方向：渲染 → 壳（`hitTest` 结果 / 帧统计 / 异常）
- AI 链路：面板/渲染 → 侧车（文本、音频块），侧车 → 渲染（语义标签流、音频流）
- 所有消息由 `packages/protocol` 定义类型，Rust 与 TS 两侧共享一份真源（建议用 JSON Schema 生成）

---

## 5. 关键技术方案

### 5.1 窗口层（最高风险，M1 必须验证）

**透明窗口**

- 使用 `WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`
- **不使用 `WS_EX_LAYERED`**：layered 需自行 `UpdateLayeredWindow` 提交位图，与 WebView2 合成机制冲突，是黑边/闪烁的根源
- 透明度由 Tauri `transparent: true` + WebView2 `DefaultBackgroundColor` 全透明实现
- `TOOLWINDOW` 保证不进任务栏与 Alt-Tab；`NOACTIVATE` 防止点击抢焦点

**鼠标穿透 + 悬停可交互**

```
SetWindowsHookExW(WH_MOUSE_LL)
  → 判定光标是否落在宠物 hit-test 区域
     命中 → 移除 WS_EX_TRANSPARENT（可拖拽、可点击）
     离开 → 恢复 WS_EX_TRANSPARENT
```

约束：钩子回调内**只做坐标判定与 `SetWindowLongPtrW`**，不得执行重活，否则拖慢全局鼠标响应并易触发杀软误报。采用"归一化 AABB 粗判 → 渲染层精确判定"两级策略。

**DPI**

- 进程级 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`
- 每次形态切换/跨屏移动后重读 `devicePixelRatio`，同步渲染分辨率与 CSS 缩放

### 5.2 双形态切换（宿主迁移）

```
切至「面板形态」
  ShowWindow(pet, SW_HIDE)
  SetWindowLongPtrW(GWL_EXSTYLE, 移除 TRANSPARENT/TOOLWINDOW/NOACTIVATE | 加 WS_CHILD)
  SetParent(pet, panel_host_hwnd)
  SetWindowPos(pet, 面板内 host 区域, SWP_FRAMECHANGED)
  ShowWindow(pet, SW_SHOW)
  → 卸载全局鼠标钩子（子窗口正常接收鼠标消息，钩子必须卸，否则重复判定）

切至「桌面形态」
  ShowWindow(pet, SW_HIDE) → SetParent(pet, NULL)
  恢复 WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
  SetWindowPos(恢复上次桌面坐标)
  ShowWindow(pet, SW_SHOW)
  → 重新安装 WH_MOUSE_LL 钩子
```

先隐藏、再切换、再显示，规避绝大部分闪烁与重绘撕裂。

**面板内三层结构**（子窗口永远绘制在父窗口之上）

```
┌ Tauri 面板窗口 ────────────────────────────────┐
│ 背景层 WebView：墙纸、地板、后景家具            │
│ 宠物层 WebView（透明，WS_CHILD）  ← 同一实例    │
│ 前景层 WebView（透明，WS_CHILD，Z 序最高）      │
└───────────────────────────────────────────────┘
```

宠物层在两个形态下**始终保持透明**——桌面形态下透出的是用户桌面，面板形态下透出的是房间背景。这个一致性让渲染层只需一套背景合成逻辑。

**异常兜底**：主进程持有宠物形态状态机；面板进程崩溃、最小化、异常退出时，强制将宠物回收至桌面形态。

### 5.3 渲染层与 CharacterRenderer

```ts
interface CharacterRenderer {
  readonly kind: 'live2d' | 'spine' | 'sprite' | 'vrm';
  load(manifest: CharacterManifest): Promise<void>;
  playMotion(group: string, id: string, priority: number): void;
  setExpression(id: string): void;
  setParameter(semantic: SemanticParam, value: number): void; // 呼吸/眨眼/摇曳
  lookAt(nx: number, ny: number): void;                       // 归一化坐标
  hitTest(x: number, y: number): SemanticArea | null;         // head/body/hand
  setBounds(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}
```

上层（情感状态机、AI 标签映射、空闲调度）**只依赖语义参数与语义部位**，永不感知底层是 Live2D 参数还是 VRM 骨骼。

**多后端热切换**：`RendererHost` 持有独立 canvas，按角色 `kind` 动态 `import()` 对应 Adapter（Vite 自动分包）。同一时刻仅一个 adapter 存活，切换角色时完整 `dispose()`。切换间隙用加载动画遮盖，不阻塞 UI。

### 5.4 角色包规范（manifest.json）

```json
{
  "id": "star-01",
  "kind": "live2d",
  "version": 1,
  "entry": "model3.json",
  "anchor": { "x": 0.5, "y": 1.0 },
  "defaultScale": 0.35,
  "semantics": {
    "lookX": "ParamAngleX",
    "lookY": "ParamAngleY",
    "breath": "ParamBreath",
    "joy": "ParamJoy",
    "lipSync": "ParamMouthOpenY"
  },
  "hitAreas": {
    "head": { "type": "drawable", "target": "D_REF.HEAD" },
    "body": { "type": "drawable", "target": "D_REF.BODY" }
  },
  "motions": { "idle": ["idle_01", "idle_02"], "tap_head": ["tap_head_01"] },
  "expressions": { "happy": "exp_happy", "angry": "exp_angry" },
  "camera": { "fov": 25, "distance": 2.4 }
}
```

`character-schema` 提供 zod schema 与 CLI，在**美术交付时**执行校验（语义参数是否齐全、hitArea 是否定义、入口文件是否存在），把问题挡在发行之前。

### 5.5 AI 层

- **对话**：云端 LLM 流式输出，输出**结构化情感标签**（`[emote:happy][motion:wave][look:user]`），映射到语义字典后再驱动渲染；禁止让上层自由文本猜意图
- **记忆**：SQLite 存结构化事实 + sqlite-vec 存向量，按时间衰减与重要性加权检索
- **语音**：Silero VAD（ONNX Runtime，本地）→ 云端/本地 ASR → 流式 LLM → 流式 TTS，全程流式、预连接
- **离线降级**：端侧小模型（如 Qwen2.5 0.5B/1.5B + llama.cpp）保底，断网时退化为有限对话而非失效
- **隐私**：麦克风采集需明示授权，音频上传需单独同意，提供"纯本地模式"开关

### 5.6 稳定性与发布

- 主进程看门狗：渲染进程崩溃自动重建；内存超阈值静默重启渲染进程（保留宠物状态快照）
- 自动更新：`tauri-plugin-updater`，支持静默增量与回滚
- 崩溃上报：Sentry（默认关闭，用户 opt-in；上报前脱敏）
- 签名：代码签名证书（**非 EV**，见 §11），降低 SmartScreen 与杀软拦截
- 依赖许可证审计：CI 集成 `cargo-deny` 与前端 license 检查，防止引入与本项目许可证冲突的依赖

---

## 6. 资产管线

### 6.1 2D（Live2D）

```
设定/原画 → Cubism Editor（建模 · 物理 · 表情）
        → 导出 model3.json + motions + textures
        → 命名规范校验（语义参数名对照表）
        → manifest.json
        → character-schema CLI 校验 → 入库
```

### 6.2 3D（VRM）

```
VRoid Studio（快速原型）或 Blender + VRM Add-on（精细建模）
        → 导出 VRM 1.0
        → gltf-transform 优化（Draco/Meshopt + KTX2 + 冗余剔除）
        → SpringBone 调参 · Expression 命名规范化
        → hitArea 包围盒标注
        → manifest.json → 校验 → 入库
```

**3D 面数与资源上限**：三角面 3–8 万，贴图 1024–2048（KTX2），SpringBone 链条 ≤ 15。

### 6.3 建模命名规范（必须在第一个模型开建前定稿）

骨骼名、Expression 名、mesh 名统一规范。缺少规范会导致每个模型都要人工适配一轮，将吞掉整个 3D 阶段的工期收益。

---

## 7. 3D 阶段的技术风险（提前登记）

| 风险 | 说明 | 应对 |
|---|---|---|
| **透明窗口 alpha 被后处理破坏** | 描边/Bloom/色调映射会导致宠物周围出现黑边白边 | 首发放弃后处理链，描边用 inverted hull 做在模型上；若必须后处理，自定义最终 pass 输出正确 alpha，全程统一 `premultipliedAlpha` |
| **无环境光照导致"飘"** | 桌面无环境贴图 | 自建虚拟三点光 + 人工环境贴图，并根据桌面明暗自适应曝光与边缘光 |
| **接地感缺失** | 无接触阴影像贴纸 | blob shadow / 简易 contact shadow |
| **透视变形** | 广角使角色不耐看 | 小 FOV 透视（20–30°）或正交 |
| **hit-test 语义化** | 3D 射线检测无法稳定区分部位 | 依赖 manifest 中预定义的语义部位包围盒或 mesh 命名 |

这五项应在 3D 阶段的**第一个冲刺内**专项验证，优先级高于接入正式模型。

---

## 8. 风险清单

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| R1 | WebView2 透明窗口在部分 Win11 版本黑边/闪烁 | 高 | M1 验证；降级路径 `DwmExtendFrameIntoClientArea` |
| R2 | `SetParent` 后 WebView2 不重排 | 高 | 补 `SetWindowPos(SWP_FRAMECHANGED)` + `InvalidateRect` |
| R3 | 全局鼠标钩子被杀软误报 | 高 | 代码签名（**非 EV**，见 §11）+ 钩子逻辑最小化。**非 EV 签名的 SmartScreen 信誉积累显著更慢**，首发期要预期更多误报，需准备白名单申请说明页 |
| R4 | 跨 DPI 宿主迁移缩放错乱 | 中 | 切换后重读 DPI 并同步渲染分辨率 |
| R5 | 集显设备 3D 性能不足 | 中 | 低端档：降分辨率、关粒子、降 SpringBone 精度 |
| R6 | Live2D Cubism 授权边界 | 中 | M1 期间核对**非商业**条款：SDK 不得随包再分发、署名展示要求、UGC 角色包场景（见 §11）。非商业定位使得"商用授权"这一最大的不确定性消失，故由高降为中 |
| R7 | 常驻内存泄漏 | 中 | 72h soak test 门槛 + 超阈值自动重启 |
| R8 | TTS 声库使用条款 | 低 | 非商业场景的限制远少于商用；选型时仍逐家确认"非商业使用与分发"是否被允许 —— 部分声库连非商业也禁止再分发或公开传播 |
| R9 | macOS 透明窗口与公证成本 | 中 | 二期专项；公证需 Apple 开发者账号年费，**与项目是否商业无关**，预算仍需保留 |

---

## 9. 里程碑

| 阶段 | 交付内容 | 周期 | 并行项 |
|---|---|---|---|
| **M1** | 透明窗口 + 穿透/悬停 + DPI/多屏 + 双形态切换 + 帧调度与降帧 | 3–4 周 | 美术启动 Live2D；核对 Cubism 非商业使用条款 |
| **M2** | `CharacterRenderer` 抽象 + Live2D Adapter + 物理 + 跟随 + 命中反馈 | 3–4 周 | `character-schema` 定稿；AI 侧记忆与编排 |
| **M3** | 角色包格式 + 设置面板（含"关于"页署名与授权入口展示）+ 自动更新 + 插件框架 | 3 周 | |
| **M4** | LLM 对话 + 长期记忆 + 语音全链路 + 离线降级 | 4 周 | |
| **M5** | VRM Adapter（3D 角色线）+ 三条 3D 专项风险验证 | 3–4 周 | 3D 建模启动，命名规范先行 |
| **M6** | 兼容矩阵测试 · 72h soak · 合规审查 · 发布管线 | 3 周 | |

**原则：M1 先啃窗口层硬骨头。** 若先做 AI 与美术，最后发现透明穿透在目标 Windows 版本上做不干净，返工代价极大。

---

## 10. 团队配置（预算充足前提）

| 角色 | 人数 | 职责 |
|---|---|---|
| Windows 客户端（Rust） | 2 | 窗口层、形态切换、性能、更新 |
| 图形/渲染工程师 | 1 | PixiJS/three.js、Adapter、渲染抽象层 |
| 前端（面板） | 1 | React 面板、商店、配置 |
| AI 后端 | 1–2 | 记忆、编排、语音链路 |
| TA / 管线 | 1 | 建模规范、manifest 工具链、自动化校验 |
| 原画 / Live2D 建模 | 1–2 | 2D 角色线 |
| 3D 建模 | 1–2（M5 进场） | VRM 角色线 |
| 测试 | 1 | 兼容矩阵、soak、自动化 |
| PM / 发行 | 1 | 排期、合规、上线 |

---

## 11. 合规与授权

**前置声明**：本项目是**非商业**项目（依据：仓库根 `LICENSE` = PolyForm Noncommercial 1.0.0）。
下表各第三方资产只需满足"非商业使用"条件，**无需**取得商用授权。
但"非商业"不等于"无条件" —— 再分发限制、署名要求、声库的公开传播限制依然存在，仍需逐项核对。
若日后转为商业发布，本表须整体重做。

| 项 | 要求 |
|---|---|
| **本项目代码** | **PolyForm Noncommercial 1.0.0**（唯一基准）：非商业范围内自由使用/修改/分发；**商业使用须取得单独授权**；`Required Notice:` 行为许可证强制的署名条款 |
| Live2D Cubism | 非商业使用下仍受约束的两点：**SDK 本体不得随包再分发**、**须展示官方要求的署名**。另需按官方当前条款确认 Cubism Editor Free 版产出的模型能否用于本项目，以及 UGC 角色包场景的处理 |
| Spine（如使用） | Editor 授权按席位；运行时授权要求与项目是否商业无关，仍需持有效授权 |
| VRM / 模型 | 格式免费，模型版权另计；自研或走正规授权 |
| TTS 声库 | 逐家确认"非商业使用"是否被允许。注意部分声库连非商业也禁止再分发或公开传播，选型时须逐条看 |
| 字体 | 确认嵌入与分发授权（SIL OFL 一般允许，仍需逐款核对） |
| 代码签名 | **非 EV**。EV 需验证组织主体且费用高，个人/非商业主体通常不具备申请条件；改用 OV/个人代码签名证书，或面向开源项目的免费签名服务（资格条件需自行核实）。代价是 SmartScreen 信誉积累慢于 EV —— 这是 R3 的直接影响 |
| 隐私 | 麦克风授权、音频上传单独同意、提供纯本地模式；遵守《个人信息保护法》 |
| 美术/音频资产（建议） | **CC BY-NC 4.0**：与代码同为非商业导向，且 CC 在内容资产领域是标准选择（CC 官方不推荐用于代码，故代码与资产分轨） |
| 依赖许可证审计 | CI 集成 `cargo-deny` 与前端 license 检查。非商业项目尤其要挡住**仅限商业授权**的依赖，否则会与本项目许可证冲突 |

---

## 12. 附录 A：关键 Win32 API 清单

| 用途 | API |
|---|---|
| 窗口样式读写 | `GetWindowLongPtrW` / `SetWindowLongPtrW`（`GWL_EXSTYLE`） |
| 样式位 | `WS_EX_TRANSPARENT`、`WS_EX_TOOLWINDOW`、`WS_EX_NOACTIVATE`、`WS_EX_LAYERED`、`WS_CHILD` |
| 宿主迁移 | `SetParent` |
| 定位与重排 | `SetWindowPos`（`SWP_FRAMECHANGED` / `SWP_NOZORDER`）、`InvalidateRect` |
| 鼠标钩子 | `SetWindowsHookExW(WH_MOUSE_LL)` / `UnhookWindowsHookEx` / `CallNextHookEx` |
| 光标位置 | `GetPhysicalCursorPos`（优于 `GetCursorPos`，DPI 敏感） |
| 显示器与 DPI | `MonitorFromPoint`、`GetDpiForMonitor`、`EnumDisplayMonitors` |
| DPI 感知 | `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` |
| 托盘 | `Shell_NotifyIconW` |
| 自启 | 注册表 Run 项 或 任务计划程序（避免需要管理员权限） |
| Rust 绑定 | `windows` / `windows-sys` crate；HWND 由 `raw_window_handle` 获取 |

---

## 13. 附录 B：语义字典（初稿，待跨团队评审）

| 语义参数 | 含义 | Live2D 示例 | VRM 示例 |
|---|---|---|---|
| `lookX` / `lookY` | 视线方向（归一化 −1..1） | `ParamAngleX/Y` | LookAt 骨骼旋转 |
| `breath` | 呼吸幅度 | `ParamBreath` | 胸部骨骼 / SpringBone |
| `blink` | 眨眼（0/1 或开合度） | `ParamEyeLOpen/ROpen` | Expression `blink` |
| `lipSync` | 口型开合 | `ParamMouthOpenY` | Viseme 混合形状 |
| `joy` / `anger` / `sadness` | 情绪强度 | 表情参数混合 | VRM Expression 权重 |

> **校验策略（已定）**：`lookX` / `lookY` / `lipSync` 为**核心必填项**，缺失即构建期失败（error 级）；`breath` / `blink` / `joy` / `anger` / `sadness` 为可选，缺失时由 `SemanticFallback` 静默降级（warning 级）。

| 语义部位 | 用途 |
|---|---|
| `head` | 拍头反馈 |
| `body` | 抚摸/抱起反馈 |
| `hand` | 牵手/递物反馈 |

| 语义动作组 | 用途 |
|---|---|
| `idle` | 空闲循环 |
| `greet` | 启动/唤醒问候 |
| `tap_<area>` | 部位点击反馈 |
| `emote_<emotion>` | 情绪表达 |
| `sleep` / `wake` | 休眠与唤醒 |

---

## 14. 待办与开放问题

1. ✅ 商业授权联系邮箱已填入 `Required Notice:` 行（3880255095@qq.com）；待确认署名主体保留个人名 `misono mika` 还是改为组织名
   —— 注：本项目按 PolyForm NC 发布，该邮箱的用途是**他人欲商业使用时**联系取得单独授权，不代表本项目自身会商业化
2. Cubism **非商业**使用条款核对（M1 内启动，**仍是阻塞项**）：重点是 SDK 不得随包再分发、署名展示要求、UGC 角色包场景。不再是"商务确认"，但结论依然决定 M3 角色包/插件框架能否按原设计做
3. 语义字典跨团队评审定稿（M2 前必须冻结）
4. 建模命名规范定稿（3D 建模启动前）
5. 代码签名方案：改为 OV/个人证书或面向开源项目的免费签名服务（EV 不适用，见 §11）；需同步评估 R3 误报率上升的应对
6. 遥测与崩溃上报的隐私合规方案细化
