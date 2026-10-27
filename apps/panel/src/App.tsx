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
 * 本窗口默认隐藏，由壳层（托盘菜单 / 形态切换）显示；关闭时壳层拦截并改为隐藏（不销毁）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CHARACTER_SCALE, FRAME_PROFILE, type CharacterSummary } from '@heart-star/protocol';
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
 * 拖动滑块时每帧都会触发一次 change。
 * 不做节流的话一次拖拽就是上百条 IPC，全砸在通道上。
 */
const THROTTLE_MS = 50;

/**
 * 尾随节流：窗口内的多次调用只在结尾发一次。
 *
 * 用 ref 而不是 state 保存句柄与待发动作，是为了不让节流本身触发额外渲染。
 * 卸载时清定时器 —— 否则最后一条消息可能打在一个已经销毁的订阅上。
 */
function useThrottle(delayMs: number) {
  const timer = useRef<number | null>(null);
  const pending = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (action: () => void) => {
      pending.current = action;
      if (timer.current !== null) return;

      timer.current = window.setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        next?.();
      }, delayMs);
    },
    [delayMs],
  );
}

/** 一行"标签 + 数值 + 滑块"。面板里三处滑块共用，样式与回显口径必须一致。 */
function SliderRow({
  label,
  readout,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  readout: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ opacity: 0.6 }}>{readout}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        // 本地先更新再节流下发：拖动过程要跟手，等 IPC 往返再更新的话手感是黏的
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#ff8fb1' }}
      />
    </div>
  );
}

/**
 * 角色切换与缩放。
 *
 * 列表由壳层扫描角色目录后下发 —— 面板与渲染层都拿不到文件系统，只有壳能读。
 * 切换与缩放也走壳层转发：渲染层只认壳这一个命令来源。
 */
function CharacterPicker() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(CHARACTER_SCALE.default);

  const throttle = useThrottle(THROTTLE_MS);

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
        case 'characterScaled':
          // 回显渲染层夹紧后的真实值：拖到边界时，这里的数字必须和模型实际大小一致
          setScale(cmd.scale);
          break;
      }
    });
  }, []);

  const changeScale = (value: number) => {
    setScale(value);
    throttle(() => sendPanelEvent({ type: 'setCharacterScale', scale: value }));
  };

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

      <div style={{ marginTop: 14, borderTop: '1px solid #e6ebf2', paddingTop: 10 }}>
        <SliderRow
          label="角色大小"
          readout={`${Math.round(scale * 100)}%`}
          value={scale}
          min={CHARACTER_SCALE.min}
          max={CHARACTER_SCALE.max}
          step={CHARACTER_SCALE.step}
          onChange={changeScale}
        />
      </div>
    </div>
  );
}

/**
 * 开机自启开关。
 *
 * 勾选后由壳层写 Windows 的 Run 键（当前用户，不需要提权），
 * 面板既拿不到文件系统也不知道注册表 —— 它只知道一个布尔值。
 *
 * 状态一律听壳层下发（`autostartChanged`）：写入可能被系统策略或杀软拦下，
 * 回显是**写完回读**的结果，所以失败时勾选框会自己弹回去，
 * 不会出现"勾上了但其实没生效"这种假象。
 *
 * 自己绑一次 IPC 而不是从 CharacterPicker 那边的订阅里分一口：
 * 面板里每一项设置各自把住自己的那条消息，加一项功能不必去动别人 ——
 * 壳侧的 ready 处理是幂等的（重发列表 + 重发自启状态），多订阅者没有副作用。
 */
function AutostartToggle() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    return bindPanelIpc((cmd) => {
      switch (cmd.type) {
        case 'autostartChanged':
          setEnabled(cmd.enabled);
          break;
      }
    });
  }, []);

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid #e6ebf2', paddingTop: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            // 先本地跟手，再下发。等壳层回显才动的话，勾一下会有肉眼可见的延迟，
            // 而且失败了回显会把状态拨回去，不需要这里先做判断。
            setEnabled(e.target.checked);
            sendPanelEvent({ type: 'setAutostart', enabled: e.target.checked });
          }}
          style={{ accentColor: '#ff8fb1' }}
        />
        <span>开机自启</span>
      </label>
    </div>
  );
}

/**
 * 帧率档位。
 *
 * 两档的含义：有交互时跑 `active` 帧，空闲 30 秒后降到 `idle` 帧。
 * 桌宠常驻桌面，这档数的取舍（要丝滑还是省电）只有用户自己知道。
 *
 * 两个值一起下发：它们是一组配置，分开发的话中间会出现"活跃档已变、
 * 空闲档还没变"的过渡态，而那个中间态没有任何意义。
 */
function FrameSliders() {
  const [active, setActive] = useState<number>(FRAME_PROFILE.active.default);
  const [idle, setIdle] = useState<number>(FRAME_PROFILE.idle.default);
  const throttle = useThrottle(THROTTLE_MS);

  // 下发时要读的是"此刻"的两个值：闭包里直接引用 state 的话，
  // 节流窗口到期时发的是触发那一次的旧快照。
  const latest = useRef({ active, idle });
  latest.current = { active, idle };

  useEffect(() => {
    return bindPanelIpc((cmd) => {
      switch (cmd.type) {
        case 'frameProfileChanged':
          // 回显是壳层夹紧后的结果：空闲档不允许高于活跃档，
          // 用户拖出来越界的组合会被压回合法区间，这里跟着更新
          setActive(cmd.activeFps);
          setIdle(cmd.idleFps);
          break;
      }
    });
  }, []);

  const change = (next: { active?: number; idle?: number }) => {
    if (next.active !== undefined) setActive(next.active);
    if (next.idle !== undefined) setIdle(next.idle);
    throttle(() => {
      const value = latest.current;
      sendPanelEvent({
        type: 'setFrameProfile',
        activeFps: value.active,
        idleFps: value.idle,
      });
    });
  };

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid #e6ebf2', paddingTop: 10 }}>
      <SliderRow
        label={`交互时帧率（${FRAME_PROFILE.idleAfterSecs} 秒内）`}
        readout={`${Math.round(active)} fps`}
        value={active}
        min={FRAME_PROFILE.active.min}
        max={FRAME_PROFILE.active.max}
        step={FRAME_PROFILE.active.step}
        onChange={(v) => change({ active: v })}
      />
      <div style={{ marginTop: 8 }}>
        <SliderRow
          label={`空闲 ${FRAME_PROFILE.idleAfterSecs} 秒后`}
          readout={`${Math.round(idle)} fps`}
          value={idle}
          min={FRAME_PROFILE.idle.min}
          max={FRAME_PROFILE.idle.max}
          step={FRAME_PROFILE.idle.step}
          onChange={(v) => change({ idle: v })}
        />
      </div>
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
        <FrameSliders />
        <AutostartToggle />
        {/* TODO(M3)：人设 / 语音 / 快捷键 */}
      </div>

      <div style={hint}>关闭本窗口，宠物会回到桌面</div>
      <About />
    </main>
  );
}
