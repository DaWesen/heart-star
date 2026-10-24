/**
 * 面板 —— 进程③
 *
 * 窗口分层（与壳层配合）：
 *   背景层（本窗口，房间场景）
 *   宠物层（renderer 进程，透明子窗口，由壳层 SetParent 挂到本窗口）
 *   前景层（可选，透明子窗口，用于让家具遮挡宠物）
 *
 * 注意：宠物不是本进程渲染的。本窗口只负责背景与 UI，
 * 宠物窗口由壳层挂载进来 —— 这样宠物状态在形态切换时才能保持连续。
 */

const ABOUT = {
  name: 'Heart Star',
  copyright: 'Copyright misono mika',
  license: 'PolyForm Noncommercial License 1.0.0',
  licenseUrl: 'https://polyformproject.org/licenses/noncommercial/1.0.0',
  commercialContact: '3880255095@qq.com',
};

/**
 * 关于页 —— 署名展示的产品侧落地。
 *
 * 代码分发时的署名靠 LICENSE 里的 `Required Notice:` 行（许可证强制义务）；
 * 成品 UI 里的署名靠这里。两者都要有，缺一则署名义务履行不完整。
 */
function About() {
  return (
    <section>
      <h2>{ABOUT.name}</h2>
      <p>{ABOUT.copyright}</p>
      <p>
        <a href={ABOUT.licenseUrl} target="_blank" rel="noreferrer">
          {ABOUT.license}
        </a>
      </p>
      <p>商业使用须经版权持有人书面授权：{ABOUT.commercialContact}</p>
    </section>
  );
}

export function App() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Heart Star</h1>
      {/* TODO(M3)：角色管理 / 人设 / 语音 / 快捷键 / 订阅 */}
      <About />
    </main>
  );
}
