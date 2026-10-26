# vendor —— 不可再分发的第三方本体

这里放**不能随仓库分发**的 SDK 本体。目前只有 Cubism Core。

## 为什么它不在仓库里

Live2D 的许可条款不允许把 Cubism SDK 本体随包再分发（见 `docs/engineering-plan.md` §11）。
仓库里只留这份说明，`*.js` 一律 gitignore，由每位使用者自行下载。

## 怎么拿到

1. 打开 Live2D 官网 <https://www.live2d.com/>，注册/登录账号；
2. 下载 **Cubism SDK for Web**（版本号要与角色模型的 moc3 版本对得上 ——
   `assets/characters/hiyori` 用的是 Cubism 4 系的示例模型）；
3. 在解压出的 SDK 里找到 `Core/live2dcubismcore.min.js`；
4. 把它复制到**本目录**下，文件名保持 `live2dcubismcore.min.js`。

放好之后重启 dev server 即可，不需要改任何代码。

## 缺了会怎样

渲染层在加载 live2d 角色时先探测 `window.Live2DCubismCore`，拿不到就直接报：

> 缺少 Cubism Core：请从 Live2D 官网下载 Cubism SDK for Web，把其中的
> live2dcubismcore.min.js 放到 apps/renderer/vendor/ 下…

这条错误会一路回传到面板，以红字显示。也就是说缺 SDK 不会静默失败，
也不会表现为"角色凭空消失"。
