/**
 * 面板 —— 进程③
 *
 * 窗口分层（与壳层配合）：
 *   背景层（本窗口，房间场景）
 *   宠物层（renderer 进程，透明子窗口，由壳层 SetParent 挂到本窗口）
 *   前景层（可选，透明子窗口，用于让家具遮挡宠物）
 *
 * 关键认知：宠物**不是本进程的 DOM**。它是另一个窗口，由壳层挂载进来 ——
 * 所以这里不能给它留一个 div 容器，也拿不到它的任何状态。
 * 这么做是为了让宠物在形态切换时动作、情绪、动画进度保持连续。
 *
 * 本窗口默认隐藏，由壳层在双击宠物时显示；关闭时壳层拦截并改为隐藏（不销毁）。
 */

import { useEffect, useState } from 'react';
import type { CharacterSummary } from '@heart-star/protocol';
import { bindPanelIpc, sendPanelEvent } from './ipc';

const ABOUT = {
  name: 'Heart Star',
  copyright: 'Copyright misono mika',
  license: 'PolyForm Noncommercial License 1.0.0',
  licenseUrl: 'https://polyformproject.org/licenses/noncommercial/1.0.0',
  commercialContact: '3880255095@qq.com',
};

const room: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100vh',
  overflow: 'hidden',
  fontFamily: 'system-ui, sans-serif',
  // 墙：上浅下深，模拟顶光
  background: 'linear-gradient(#f4f7fb 0%, #e3eaf3 60%, #d8e0ec 100%)',
};

const floor: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: '34%',
  background: 'linear-gradient(#c9a57a 0%, #b8905f 100%)',
  boxShadow: 'inset 0 2px 0 rgba(0,0,0,0.08)',
};

const rug: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: '8%',
  width: 420,
  height: 120,
  transform: 'translateX(-50%)',
  borderRadius: '50%',
  background: 'radial-gradient(ellipse at center, #e8d5c4 0%, #d8bfa6 100%)',
  opacity: 0.9,
};

const windowFrame: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  left: 72,
  width: 210,
  height: 160,
  borderRadius: 8,
  border: '6px solid #fff',
  background: 'linear-gradient(#bfe3f5 0%, #eaf6fb 100%)',
  boxShadow: '0 4px 14px rgba(0,0,0,0.10)',
};

const card: React.CSSProperties = {
  padding: '14px 18px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.86)',
  boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
  fontSize: 13,
  lineHeight: 1.7,
  color: '#3a3f4a',
};

const panelRight: React.CSSProperties = {
  position: 'absolute',
  right: 24,
  top: 24,
  width: 220,
  ...card,
};

const aboutCard: React.CSSProperties = {
  position: 'absolute',
  left: 24,
  bottom: 24,
  ...card,
};

const hint: React.CSSProperties = {
  position: 'absolute',
  right: 24,
  bottom: 24,
  padding: '8px 14px',
  borderRadius: 999,
  background: 'rgba(0,0,0,0.32)',
  color: '#fff',
  fontSize: 12,
};

const buttonBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid #cfd8e3',
  background: '#fff',
  color: '#3a3f4a',
  fontSize: 13,
  cursor: 'pointer',
  textAlign: 'left',
};

const buttonActive: React.CSSProperties = {
  ...buttonBase,
  borderColor: '#ff8fb1',
  background: '#fff1f5',
  fontWeight: 600,
};

/**
 * 角色切换。
 *
 * 列表由壳层扫描角色目录后下发 —— 面板与渲染层都拿不到文件系统，只有壳能读。
 * 切换也走壳层转发：渲染层只认壳这一个命令来源。
 */
function CharacterPicker() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return bindPanelIpc((cmd) => {
      switch (cmd.type) {
        case 'characterList':
          // 刻意不"默认高亮第一个"：启动时用的是占位角色，未必等于列表里的任何一项。
          // 高亮一个没在显示的角色，比不高亮更误导。
          setCharacters(cmd.characters);
          break;
        case 'characterSwitched':
          setCurrent(cmd.characterId);
          setError(null);
          break;
        case 'characterFailed':
          // 失败时清掉高亮：继续高亮新角色会让人误以为已经切过去了
          setError(cmd.message);
          setCurrent(null);
          break;
      }
    });
  }, []);

  return (
    <div>
      <strong>角色</strong>
      {characters.length === 0 ? (
        <div style={{ marginTop: 6, opacity: 0.6 }}>未发现角色包</div>
      ) : (
        characters.map((c) => (
          <button
            key={c.id}
            type="button"
            style={c.id === current ? buttonActive : buttonBase}
            onClick={() => sendPanelEvent({ type: 'switchCharacter', characterId: c.id })}
          >
            {c.displayName}
            <span style={{ float: 'right', opacity: 0.5 }}>{c.kind}</span>
          </button>
        ))
      )}
      {error && (
        <div style={{ marginTop: 8, color: '#c0392b', fontSize: 12 }}>切换失败：{error}</div>
      )}
    </div>
  );
}

/**
 * 关于页 —— 署名展示的产品侧落地。
 *
 * 代码分发时的署名靠 LICENSE 里的 `Required Notice:` 行（许可证强制义务）；
 * 成品 UI 里的署名靠这里。两者都要有，缺一则署名义务履行不完整。
 *
 * 使用 Live2D 示例模型时，还必须在此展示官方要求的声明，
 * 文案见 assets/characters/hiyori/NOTICE.md。
 */
function About() {
  return (
    <div style={aboutCard}>
      <strong>{ABOUT.name}</strong>
      <div>{ABOUT.copyright}</div>
      <div>
        <a href={ABOUT.licenseUrl} target="_blank" rel="noreferrer">
          {ABOUT.license}
        </a>
      </div>
      <div>商业使用须经版权持有人书面授权：{ABOUT.commercialContact}</div>
    </div>
  );
}

export function App() {
  return (
    <main style={room}>
      <div style={windowFrame} />
      <div style={floor} />
      <div style={rug} />

      <div style={panelRight}>
        <CharacterPicker />
        {/* TODO(M3)：人设 / 语音 / 快捷键 */}
      </div>

      <div style={hint}>关闭本窗口，宠物会回到桌面</div>
      <About />
    </main>
  );
}
