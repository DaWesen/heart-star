import type { SemanticParam } from '@heart-star/character-schema';

/**
 * 程序化动作片段 —— **不依赖素材**的动作。
 *
 * 为什么需要它：动作文件（motion3.json）是美术产物，数量有限且改不动。
 * 而"探头""摇头""蹦一下""伸懒腰""打瞌睡"这类小动作，本质上只是
 * 几个姿态参数随时间走一条曲线 —— 完全可以自己合成。
 *
 * 与动作文件的关系是**互斥**而不是叠加：
 * 动作在播放时会每帧把它的曲线值写进模型参数，
 * 我们写的姿态会被它整帧覆盖，于是程序化动作看起来像没生效。
 * 所以片段只在没有动作播放时才排（见 IdleDirector），
 * 一旦用户点了它（要播动作了），片段立刻让位。
 *
 * 曲线值是**语义单位**（0..1），姿态类的中位是 `CENTER`（0.5）：
 * 具体角度范围由模型自己声明，这里不碰模型私有的参数名与量纲。
 */
/**
 * 一条轨道。两种：
 *  - 参数轨道：驱动某个语义参数（姿态、表情…）
 *  - 位移轨道（`lift`）：把角色整体上/下移动 —— 参数做不到"离开地面"这种事
 */
export type ClipTrack =
  | {
      semantic: SemanticParam;
      /** [时刻(秒), 取值(0..1)] 关键点，按时刻升序 */
      keys: readonly (readonly [number, number])[];
    }
  | {
      kind: 'lift';
      /** [时刻(秒), 离地比例(-1..1)] 关键点，按时刻升序 */
      keys: readonly (readonly [number, number])[];
    };

export interface Clip {
  id: string;
  duration: number;
  /** 循环到被打断。给"打瞌睡"这类**持续状态**用，一次性动作用不到 */
  loop?: boolean;
  tracks: readonly ClipTrack[];
}

/** 姿态类的中位。其余语义（crouch / armRaise / blink）的自然态是 0。 */
const CENTER = 0.5;

/** 每个语义的"松手后回到哪"。片段结束或被中断时用它把姿态抹平。 */
const REST: Partial<Record<SemanticParam, number>> = {
  poseX: CENTER,
  poseY: CENTER,
  poseZ: CENTER,
  crouch: 0,
  armRaise: 0,
  blink: 0,
  breath: 0,
};

const restOf = (semantic: SemanticParam): number => REST[semantic] ?? CENTER;

export const CLIPS = {
  /** 探头：低头凑近一点，再回到正位 */
  peek: {
    id: 'peek',
    duration: 1.4,
    tracks: [{ semantic: 'poseY', keys: [[0, CENTER], [0.5, 0.34], [1.4, CENTER]] }],
  },

  /** 摇头：左右各一下，带一点歪头 —— 纯左右平移看着像机械摆动 */
  shakeHead: {
    id: 'shakeHead',
    duration: 1.6,
    tracks: [
      {
        semantic: 'poseX',
        keys: [
          [0, CENTER],
          [0.4, 0.32],
          [0.9, 0.68],
          [1.4, CENTER],
        ],
      },
      {
        semantic: 'poseZ',
        keys: [
          [0, CENTER],
          [0.4, 0.58],
          [0.9, 0.42],
          [1.4, CENTER],
        ],
      },
    ],
  },

  /** 蹦一下：先压下去再弹起来 */
  hop: {
    id: 'hop',
    duration: 0.7,
    tracks: [
      {
        semantic: 'crouch',
        keys: [
          [0, 0],
          [0.2, 0.9],
          [0.45, 0],
          [0.7, 0],
        ],
      },
      {
        semantic: 'poseY',
        keys: [
          [0, CENTER],
          [0.45, 0.62],
          [0.7, CENTER],
        ],
      },
    ],
  },

  /** 伸懒腰：双手抬起 + 抬头 + 微微下沉，慢起慢落 */
  stretch: {
    id: 'stretch',
    duration: 2.6,
    tracks: [
      {
        semantic: 'armRaise',
        keys: [
          [0, 0],
          [0.9, 1],
          [1.7, 1],
          [2.6, 0],
        ],
      },
      {
        semantic: 'poseY',
        keys: [
          [0, CENTER],
          [0.9, 0.68],
          [1.7, 0.66],
          [2.6, CENTER],
        ],
      },
      {
        semantic: 'crouch',
        keys: [
          [0, 0],
          [0.9, 0.22],
          [1.7, 0.22],
          [2.6, 0],
        ],
      },
    ],
  },

  /**
   * 打瞌睡：**点头**循环 —— 慢慢低下头，顿一会儿，猛地抬起来，再循环。
   *
   * 做成循环而不是一次性动作：它是"当前状态"而不是"发生了一件事"。
   * 首尾都落在中位，循环接缝处才不会跳。
   */
  doze: {
    id: 'doze',
    duration: 5,
    loop: true,
    tracks: [
      {
        semantic: 'poseY',
        keys: [
          [0, CENTER],
          [1.6, 0.28],
          [3.4, 0.26],
          [4.1, 0.58],
          [5, CENTER],
        ],
      },
      {
        semantic: 'poseZ',
        keys: [
          [0, CENTER],
          [2.5, 0.44],
          [5, CENTER],
        ],
      },
      {
        semantic: 'crouch',
        keys: [
          [0, 0],
          [1.6, 0.18],
          [3.4, 0.18],
          [5, 0],
        ],
      },
    ],
  },

  /**
   * 被拎起来：**悬挂姿态**，一直保持到被放下。
   *
   * 素材里那个（Flick m03）是"被横向挥开"的反应，幅度小、又只有几秒，
   * 而拖拽时窗口在跟着鼠标走 —— 相对运动为零，再小的动作就彻底看不出来了。
   * 所以这里不做"一个动作"，而是做一个**状态**：腿收起、身体后仰、手臂被拉起，
   * 再加一点点左右晃动表示"被提在半空"。循环播，松手才结束。
   */
  grab: {
    id: 'grab',
    duration: 2.4,
    loop: true,
    tracks: [
      // 离地：被提起来那一下必须是**位移**，姿态参数造不出"脚离开地面"
      { kind: 'lift', keys: [[0, 0], [0.22, 1], [1.2, 0.92], [2.4, 1]] },
      { semantic: 'crouch', keys: [[0, 0.2], [0.22, 0.85], [1.6, 0.78], [2.4, 0.85]] },
      { semantic: 'poseY', keys: [[0, CENTER], [0.22, 0.66], [1.6, 0.6], [2.4, 0.66]] },
      // 悬在半空会晃：这一下是"被拎着"和"摆拍"的区别
      { semantic: 'poseZ', keys: [[0, CENTER], [0.6, 0.64], [1.8, 0.4], [2.4, CENTER]] },
      // 左右摆：只往一边歪看着像挂歪了，来回摆才像"被提着晃"
      { semantic: 'poseX', keys: [[0, CENTER], [0.8, 0.42], [1.6, 0.58], [2.4, CENTER]] },
      // 扑腾两下：被凭空拎起来会挣扎，这是整个动作里最像"有反应"的一下
      {
        semantic: 'armRaise',
        keys: [
          [0, 0],
          [0.3, 0.55],
          [0.6, 0.85],
          [0.95, 0.5],
          [1.35, 0.8],
          [1.9, 0.5],
          [2.4, 0.55],
        ],
      },
    ],
  },

  /**
   * 被放下：从悬挂姿态落地。
   *
   * 关键帧的起点刻意接着 `grab` 的姿态写：松手那一刻是从"半空"开始的，
   * 从中位起手会先跳一下再动。
   */
  drop: {
    id: 'drop',
    duration: 0.9,
    tracks: [
      // 落地：先掉到地面，再压一下弹回（1.0 → -0.06 → 0）
      { kind: 'lift', keys: [[0, 1], [0.28, -0.06], [0.9, 0]] },
      { semantic: 'crouch', keys: [[0, 0.85], [0.35, 0.95], [0.9, 0]] },
      { semantic: 'poseY', keys: [[0, 0.66], [0.3, 0.36], [0.9, CENTER]] },
      { semantic: 'poseZ', keys: [[0, 0.6], [0.9, CENTER]] },
      { semantic: 'armRaise', keys: [[0, 0.55], [0.9, 0]] },
    ],
  },

  /** 惊醒：打瞌睡被打断时的一下抬头 */
  startle: {
    id: 'startle',
    duration: 0.9,
    tracks: [
      {
        semantic: 'poseY',
        keys: [
          [0, 0.28],
          [0.25, 0.72],
          [0.9, CENTER],
        ],
      },
      {
        semantic: 'poseZ',
        keys: [
          [0, 0.44],
          [0.35, 0.62],
          [0.9, CENTER],
        ],
      },
      { semantic: 'crouch', keys: [[0, 0.18], [0.9, 0]] },
    ],
  },
} satisfies Record<string, Clip>;

export type ClipId = keyof typeof CLIPS;

/** 按 id 取片段。组名也可能是程序化片段名（`playMotion` 两类都收）。 */
export const findClip = (id: string): Clip | null =>
  Object.prototype.hasOwnProperty.call(CLIPS, id) ? (CLIPS[id as ClipId] as Clip) : null;

type Keys = readonly (readonly [number, number])[];

/** 关键点采样：线性插值 + smoothstep 缓动，避免折线感。 */
function sample(keys: Keys, t: number): number {
  if (keys.length === 0) return CENTER;
  const first = keys[0];
  if (!first) return CENTER;
  if (t <= first[0]) return first[1];

  for (let i = 1; i < keys.length; i += 1) {
    const prev = keys[i - 1];
    const next = keys[i];
    if (!prev || !next) continue;
    if (t <= next[0]) {
      const span = next[0] - prev[0];
      const u = span <= 0 ? 1 : (t - prev[0]) / span;
      return prev[1] + (next[1] - prev[1]) * smoothstep(u);
    }
  }
  const last = keys[keys.length - 1];
  return last ? last[1] : CENTER;
}

const smoothstep = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
};

/**
 * 程序化动作会动的姿态语义。
 *
 * 为什么需要一个**全集**，而不是"当前片段写过哪些就抹平哪些"：
 * 片段之间的轨道根本不齐 —— `grab` 写 poseX 而 `drop` 不写，
 * 于是拖完放手之后 poseX 会永远停在 grab 被中断的那一帧上，
 * 人就这么歪着头不动了，而且没有任何报错：她看着像"卡在了某个姿势"。
 *
 * 新增任何姿态轨道时**必须同步加进这张表**，漏一项的后果都一样
 * （某个姿态回不来），只是换一个参数名。
 *
 * 刻意**不含** blink / breath 这类表情语义：它们有库自己的自动驱动，
 * 每帧写一次等于把眨眼和呼吸压死。
 */
const POSE_SEMANTICS: readonly SemanticParam[] = [
  'poseX',
  'poseY',
  'poseZ',
  'crouch',
  'armRaise',
];

/** 姿态全量归位。每帧写参数时以它打底，本片段写的再盖上去。 */
function restPose(): Map<SemanticParam, number> {
  const out = new Map<SemanticParam, number>();
  for (const semantic of POSE_SEMANTICS) {
    out.set(semantic, restOf(semantic));
  }
  return out;
}

/**
 * 片段播放器。同一时刻只播一个 —— 两个片段叠加会互相打架，
 * 而"同时探头又摇头"根本不是一个能做出来的动作。
 */
export class ClipPlayer {
  private clip: Clip | null = null;
  private time = 0;
  /**
   * 当前片段播完之后接着播的片段。
   *
   * 为什么需要它而不是让宿主自己排：宿主没有"这一帧刚好播完"的时刻 ——
   * 它只知道"还有没有在播"。而"落地之后甩甩头"这种两拍动作，
   * 第二拍必须接在第一播完的那一帧上，晚一帧就会顿一下。
   */
  private queued: Clip | null = null;

  /**
   * 当前离地量（-1..1）。宿主每帧读它交给渲染器 —— 位移不在语义参数里，
   * 塞不进参数表，只能单独出一趟。
   */
  lift = 0;

  get playing(): boolean {
    return this.clip !== null;
  }

  /**
   * 播一个片段。
   * @param then 播完之后接的片段（两拍动作的第二拍），不接就传 null
   */
  play(clip: Clip, then: Clip | null = null): void {
    this.clip = clip;
    this.time = 0;
    this.queued = then;
  }

  /**
   * 中断当前片段，把姿态抹平、把人放回地面。
   * @returns 需要写回的语义值；没在播时返回 null
   */
  stop(): Map<SemanticParam, number> | null {
    const clip = this.clip;
    if (!clip) return null;
    this.clip = null;
    this.time = 0;
    this.lift = 0;
    // 被打断就别再接第二拍了：那是"上一件事的尾巴"，
    // 在新一件事上面补一个旧尾巴看着像抽搐
    this.queued = null;
    // 抹平的是**全部**姿态而不是本片段的轨道：
    // 上一个片段写过的姿态可能不在本片段的轨道里，只抹本片段的会留下残留
    return restPose();
  }

  /**
   * 推进一帧。
   *
   * @returns 本帧要写的语义值；没在播时返回 null。
   *          片段**播完的那一帧**返回的是"回到自然态"的值，
   *          这样宿主不用区分"结束"与"播放中" —— 拿到就写。
   *          离地量走 `lift` 字段，不在这里返回。
   */
  update(dt: number): Map<SemanticParam, number> | null {
    const clip = this.clip;
    if (!clip) return null;

    this.time += dt;

    if (!clip.loop && this.time >= clip.duration) {
      const next = this.queued;
      this.queued = null;
      if (next) {
        // 无缝接力：本帧就从头取第二拍，中间不留空帧
        this.clip = next;
        this.time = 0;
        return this.sampleAll(next, 0);
      }
      this.clip = null;
      this.time = 0;
      this.lift = 0;
      return restPose();
    }

    const t = clip.loop ? this.time % clip.duration : this.time;
    return this.sampleAll(clip, t);
  }

  private sampleAll(clip: Clip, t: number): Map<SemanticParam, number> {
    // 以"全部姿态归位"打底，本片段的轨道再盖上去。
    // 这样不在本片段轨道里的姿态每帧都在往自然态走，
    // 上一个片段的残留不可能留下来 —— 姿态卡住这一类问题从根上断掉。
    const out = restPose();
    // 位移同理：每帧先归零再按轨道写，
    // 否则从带 lift 的片段换到不带 lift 的片段时人会一直悬在半空
    this.lift = 0;
    for (const track of clip.tracks) {
      if ('semantic' in track) {
        out.set(track.semantic, sample(track.keys, t));
      } else {
        this.lift = sample(track.keys, t);
      }
    }
    return out;
  }
}
