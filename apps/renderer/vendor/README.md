# vendor —— 不可再分发的第三方本体

这里放**不能随仓库分发**的 SDK 本体。目前只有 Cubism Core。

## 为什么它不在仓库里

当初按"SDK 本体不得随包再分发"（工程计划 §11）处理，`*.js` 一律 gitignore，
由每位使用者自行下载。

**但这个前提需要修订**：SDK 里的 `Core/RedistributableFiles.txt` 明确把
`live2dcubismcore.d.ts` / `live2dcubismcore.js` / `live2dcubismcore.min.js`
列为**可再分发**文件（依据 Live2D Proprietary Software License Agreement）。
也就是说把 Core 入库是被许可条款允许的 —— 185 KB 换掉一步手工配置，
要不要这么做留待拍板；在此之前仍按下述步骤自行放置。

## 怎么拿到

1. 打开 Live2D 官网 <https://www.live2d.com/>，注册/登录账号；
2. 下载 **Cubism SDK for Web — Cubism 4** 版本
   （`CubismSdkForWeb-4-r.7.zip` 一类）。
   版本要对得上：`assets/characters/hiyori` 用的是 Cubism 4 系示例模型，
   `hiyori_pro_t11.model3.json` 里 `"Version": 3`。
   Cubism 5 的 Core 与 pixi-live2d-display 的 cubism4 分支不保证兼容，
   先用 4 系最稳；
3. 解压后在 **`<SDK>/Core/live2dcubismcore.min.js`** 找到它
   （注意不是 `Framework/` 下的，也不是 `Core/live2dcubismcore.js` 之外的别的包）；
4. 复制到**本目录**，文件名保持 `live2dcubismcore.min.js`。

放好之后重启 dev server（或 `make dev`）即可，不需要改任何代码。

> 模型资源本身在 `assets/characters/hiyori/runtime/`（moc3、贴图、motion3），
> 同样不入库，但**不需要**从这里下载 —— 由各自的角色包提供。

## 缺了会怎样

渲染层在加载 live2d 角色时先探测 `window.Live2DCubismCore`，拿不到就直接报：

> 缺少 Cubism Core：请从 Live2D 官网下载 Cubism SDK for Web，把其中的
> live2dcubismcore.min.js 放到 apps/renderer/vendor/ 下…

这条错误会一路回传到面板，以红字显示。也就是说缺 SDK 不会静默失败，
也不会表现为"角色凭空消失"。
