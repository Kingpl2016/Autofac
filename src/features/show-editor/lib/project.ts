import type { FixtureModel } from "@/features/fixtures";

/**
 * 节目工程（`ShowProject`）的数据模型。
 *
 * - 时间一律用整数毫秒；输出节拍固定 30 FPS（见 [`OUTPUT_FPS`]）。
 * - 灯具模型在工程里保存一份快照（`fixtureModels`），素材库之后改动或换一台电脑打开都不影响已有节目。
 * - 工程文件格式带 `version`，不兼容的改动必须递增版本并提供迁移。
 */

/**
 * 工程文件格式版本。
 *
 * - v1：静态 / 特效 Cue。
 * - v2：属性分层片段（`look`）、场景片段（`scene`）、参数关键帧与数值曲线、多灯分布、预设库、
 *   段落、循环区间、灯具舞台坐标与多重配接、Universe 路由表、通道锁定（Park）。
 *   v1 文件经 `migrateProject` 无损升级（旧 Cue 在 v2 里仍然合法）。
 * - v3：多媒体轨道：素材库（`media`）与时间线上的媒体片段（`mediaTracks` / `mediaClips`）分开，
 *   同一素材可以放多次，片段可裁剪入出点、调音量与淡入淡出。v2 的“素材偏移”迁移成每个素材一条轨道一个片段。
 */
export const PROJECT_VERSION = 3;

/** 输出帧率（固定）。 */
export const OUTPUT_FPS = 30;

/** 一个 Universe 的 DMX 通道数。 */
export const DMX_CHANNELS = 512;

/** 新工程的默认 Gamma：1.0 即关闭 Gamma 校正（线性输出，DMX 值与所选颜色一致）。 */
export const DEFAULT_GAMMA = 1;

/** 打开 Gamma 校正时的推荐值（常见 LED 灯具的感知校正）。 */
export const RECOMMENDED_GAMMA = 2.2;

/** Universe 编号上限（`.artrec` 规范：net 0~127 × subuni 0~15）。 */
export const MAX_UNIVERSE = 2047;

/** 灯具实例：素材库里某个模型在节目里的一次实例化，同时记录它的 DMX 地址（Patch）。 */
export interface FixtureInstance {
  id: string;
  /** 显示名，例如“RGBW 3” */
  name: string;
  /** 所用模型编号（对应 `fixtureModels`） */
  modelId: string;
  /** Universe 编号，0 起 */
  universe: number;
  /** 起始地址，1~512 */
  address: number;
  /** 所用通道模式（对应模型的 `modes`）；省略为默认模式 */
  modeId?: string;
  /** 舞台位置（舞台监视器与按位置展开的分布用）；省略时按序自动排布 */
  stage?: StagePlacement;
  /** 多重配接：同样的输出再写到这些地址（例如左右对称的两组灯共用一个实例） */
  mirrors?: PatchAddress[];
}

/** 一个 DMX 地址。 */
export interface PatchAddress {
  /** Universe，0 起 */
  universe: number;
  /** 起始地址，1~512 */
  address: number;
}

/** 灯具在舞台上的位置。坐标单位为米，原点在舞台中央前沿，x 向右、y 向后（纵深）、z 向上。 */
export interface StagePlacement {
  x: number;
  y: number;
  /** 安装高度，省略为 0 */
  z?: number;
  /** 水平朝向（度，0 为朝向观众） */
  rotation?: number;
  /** 倒装（吊挂）：Pan / Tilt 方向反转 */
  hanging?: boolean;
}

/** 灯具分组：成员顺序决定特效沿灯具推进时的先后。 */
export interface FixtureGroup {
  id: string;
  name: string;
  fixtureIds: string[];
}

/**
 * 轨道绑定的对象：一个灯具、一个分组，或“场景”（片段自带灯具列表，见 {@link SceneClip}）。
 */
export type TrackTarget =
  | { kind: "fixture"; id: string }
  | { kind: "group"; id: string }
  | { kind: "scene" };

/** 时间线轨道。灯具 / 分组轨道的名字取自绑定对象；场景轨道用 `name`。 */
export interface Track {
  id: string;
  target: TrackTarget;
  mute: boolean;
  solo: boolean;
  lock: boolean;
  /** 场景轨道的名字（灯具 / 分组轨道忽略） */
  name?: string;
  /** 时间线上折叠（分组轨道折叠成员子轨，场景轨道折叠灯具子车道） */
  collapsed?: boolean;
  /** 轨道高度档位，省略为标准 */
  height?: "compact" | "normal" | "tall";
  /** 置顶层：颜色 / 属性在所有其它轨道之后应用（编辑器的编程器预览用，与后端 `Track::on_top` 一致） */
  onTop?: boolean;
}

/** 参数在相邻关键帧之间的插值方式。 */
export type Curve = "linear" | "hold" | "easeIn" | "easeOut" | "easeInOut" | "sCurve";

/** 一个关键帧：时间相对片段起点。 */
export interface Keyframe<T> {
  tMs: number;
  value: T;
  /** 从本帧到下一帧的插值方式 */
  curve: Curve;
}

/** 数值曲线的形状。 */
export type WaveShape = "sine" | "triangle" | "saw" | "square" | "ramp" | "random";

/** 数值曲线：在片段时长内按形状在 `from` 与 `to` 之间变化，可重复多次。 */
export interface ValueCurve {
  shape: WaveShape;
  from: number;
  to: number;
  /** 片段内的循环次数，至少 1（`ramp` 只用第一段） */
  cycles: number;
  /** 起始相位 0~1 */
  phase: number;
  /** 方波的占空比 0~1 */
  duty?: number;
}

/**
 * 一个可随时间变化的参数：固定值、关键帧序列，或（仅数值）数值曲线。
 * 关键帧按 `tMs` 升序；第一帧之前取第一帧的值，最后一帧之后取最后一帧的值。
 */
export type Param<T> =
  | { kind: "value"; value: T }
  | { kind: "keys"; keys: Keyframe<T>[] }
  | (T extends number ? { kind: "curve"; curve: ValueCurve } : never);

/** RGB 意图下白光类发光体的用法（与后端 `WhiteStrategy` 一致）。 */
export type WhiteStrategy = "off" | "preserve" | "boost";

/** 发光体键（与 `ChannelFunction` 里的发光体同名）。 */
export type EmitterKey = "red" | "green" | "blue" | "white" | "coolWhite" | "warmWhite" | "amber" | "uv" | "lime" | "indigo";

/**
 * 颜色值：存“意图色”，由每台灯的混色器换算成通道值；也可以按发光体直接给定（手动覆盖）。
 */
export type ColorValue =
  | { kind: "rgb"; rgb: Rgb; white?: WhiteStrategy }
  | { kind: "kelvin"; kelvin: number }
  | { kind: "manual"; values: Partial<Record<EmitterKey, number>> };

/**
 * 非颜色属性键：取值统一为 0~1 的 DMX 分数（界面按物模型换算成角度、能力区间等）。
 * 与 `ChannelFunction` 同名，不含发光体、调光与开关（它们由强度与颜色层驱动）。
 */
export type AttrKey =
  | "pan"
  | "tilt"
  | "speed"
  | "shutter"
  | "colorWheel"
  | "colorWheelRotate"
  | "cyan"
  | "magenta"
  | "yellow"
  | "colorTemp"
  | "gobo"
  | "goboRotate"
  | "goboShake"
  | "prism"
  | "prismRotate"
  | "frost"
  | "focus"
  | "zoom"
  | "iris"
  | "blade"
  | "bladeRotate"
  | "rotation"
  | "macro"
  | "reset"
  | "fog"
  | "effectSpeed"
  | "maintenance";

/** 属性分层的“外观”：只写出现的层，没出现的层不参与（不覆盖其它片段 / 默认值）。 */
export interface Look {
  /** 强度 0~100（%） */
  intensity?: Param<number>;
  color?: Param<ColorValue>;
  /** 其它属性，0~1 DMX 分数 */
  attrs?: Partial<Record<AttrKey, Param<number>>>;
  /** 引用的预设：预设的各层作为底，本外观里显式写出的层覆盖它 */
  presetId?: string;
}

/** 分布里可以展开的量：强度、色相偏移（度）、数值曲线的相位偏移（周期的分数）或某个属性。 */
export type SpreadKey = "intensity" | "hue" | "phase" | AttrKey;

/**
 * 多灯分布（Fan / MAtricks）：把一个片段在轨道成员之间展开。
 *
 * - `values`：成员按顺序从 `from` 线性过渡到 `to`（强度为 %、色相为度的偏移、属性为 DMX 分数），
 *   覆盖外观里同名层的值；
 * - `delay`：时间级联，成员按顺序从 `fromMs` 到 `toMs` 推迟进入（形成波浪）；
 * - `wings`：分翼，2 为左右对称（中间向两边展开），更多为重复分段；
 * - `order`：成员顺序的来源。
 */
export interface Spread {
  order?: "members" | "reverse" | "stageX" | "stageY";
  wings?: number;
  values?: Partial<Record<SpreadKey, { from: number; to: number }>>;
  delay?: { fromMs: number; toMs: number };
}

/** 属性分层片段：在轨道（灯具 / 分组）上显示一个外观，可带分布。 */
export interface LookClip extends CueBase {
  kind: "look";
  look: Look;
  spread?: Spread;
  /** 片段的名称（时间线上显示；Cue 模板 / 属性特效放下时写入，可在属性面板里改；不影响输出） */
  label?: string;
}

/** 场景片段里一台灯具的外观。 */
export interface SceneEntry {
  fixtureId: string;
  look: Look;
}

/** 场景片段：同一时刻给多台灯具分别设定外观（只写“参与”的属性），放在场景轨道上。 */
export interface SceneClip extends CueBase {
  kind: "scene";
  entries: SceneEntry[];
  /** 片段的名称（时间线上显示；不影响输出） */
  label?: string;
}

/** 预设：可被片段引用的外观，修改后所有引用它的片段一起变化。 */
export interface Preset {
  id: string;
  name: string;
  /** 分类（素材库筛选用） */
  group: "intensity" | "color" | "position" | "beam" | "all";
  look: Look;
}

/** 歌曲段落（前奏 / 主歌 / 副歌…），用于批量编排与复用。 */
export interface Section {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
  color: Rgb;
}

/** 淡入淡出的缓动曲线。 */
export type Easing = "linear" | "easeInOut" | "sCurve";

/** 内置特效类型。 */
export type EffectId =
  | "breathe"
  | "rainbow"
  | "chase"
  | "wipe"
  | "gradient"
  | "pulse"
  | "sparkle"
  | "strobe";

/** RGB 颜色，每个分量 0~255。 */
export type Rgb = [number, number, number];

/** Cue 的公共字段。 */
export interface CueBase {
  id: string;
  trackId: string;
  startMs: number;
  endMs: number;
  /** 亮度，0~100 */
  brightness: number;
  fadeInMs: number;
  fadeOutMs: number;
  easing: Easing;
  /** 禁用：保留在时间线上但不输出（与后端 `CueBase::disabled` 一致），省略为启用 */
  disabled?: boolean;
  /** 颜色标签（只用于在时间线上分类、筛选，不影响输出） */
  tag?: CueTag;
}

/** 片段颜色标签。 */
export const CUE_TAGS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;

/** 片段颜色标签。 */
export type CueTag = (typeof CUE_TAGS)[number];

/** 各颜色标签的显示色（数据色，不随主题变化）。 */
export const CUE_TAG_COLORS: Record<CueTag, Rgb> = {
  red: [239, 68, 68],
  orange: [249, 115, 22],
  yellow: [234, 179, 8],
  green: [34, 197, 94],
  cyan: [6, 182, 212],
  blue: [59, 130, 246],
  purple: [168, 85, 247],
  pink: [236, 72, 153],
};

/** 静态 Cue：固定颜色。 */
export interface StaticCue extends CueBase {
  kind: "static";
  rgb: Rgb;
}

/** 特效 Cue：在块的时间范围内持续运行的程序化效果。 */
export interface EffectCue extends CueBase {
  kind: "effect";
  effect: EffectId;
  /** 1~4 个颜色 */
  colors: Rgb[];
  /** 周期：毫秒，或按 BPM 的拍数 */
  period: { kind: "ms"; ms: number } | { kind: "beats"; beats: number };
  /** 沿灯具的相位扩散，0~1 */
  phaseSpread: number;
  direction: 1 | -1;
  /** 亮度范围（0~100） */
  range: [number, number];
  /** 随机种子（保证预览、播放、导出一致） */
  seed: number;
}

/** 时间线上的片段（Cue）。 */
export type Cue = StaticCue | EffectCue | LookClip | SceneClip;

/** 音视频素材引用（素材库里的一项，只记录路径，不复制进工程）。 */
export interface MediaRef {
  id: string;
  kind: "audio" | "video";
  path: string;
  name: string;
  durationMs: number;
}

/** 媒体轨道（音频或视频）：放媒体片段，同一轨道上的片段不重叠。 */
export interface MediaTrack {
  id: string;
  kind: MediaRef["kind"];
  name: string;
  mute: boolean;
  solo: boolean;
  lock: boolean;
  /** 轨道音量 0~1 */
  volume: number;
  /** 轨道高度档位，省略为标准 */
  height?: "compact" | "normal" | "tall";
}

/** 时间线上的一个媒体片段：素材 `[inMs, inMs + durationMs)` 这一段放在时间线 `startMs` 处。 */
export interface MediaClip {
  id: string;
  trackId: string;
  mediaId: string;
  /** 时间线上的起点（毫秒） */
  startMs: number;
  /** 素材内的入点（毫秒） */
  inMs: number;
  /** 在时间线上的长度（毫秒） */
  durationMs: number;
  /** 片段音量 0~1 */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** 单独静音这个片段 */
  muted?: boolean;
}

/** 时间线标记点。 */
export interface Marker {
  id: string;
  timeMs: number;
  label: string;
}

/** 节拍设置（用于网格与“按拍”的特效周期）。 */
export interface Tempo {
  bpm: number;
  /** 第一拍相对 0 点的偏移（毫秒） */
  offsetMs: number;
  beatsPerBar: number;
}

/**
 * 输出目标（与后端 `DispatchTarget` 的序列化形态一致）。
 *
 * - `forwarding`：走全局转发表；
 * - `direct`：所有 Universe 发往同一地址，编号不变；
 * - `routed`：按工程自己的 Universe 表（`OutputSettings.universes`）逐个路由。
 */
export type OutputTarget =
  | { kind: "forwarding" }
  | { kind: "direct"; ip: string; protocol: "artNet" | "sacn"; port: number }
  | { kind: "routed" };

/** Universe 的一个输出端口。 */
export interface UniversePort {
  id: string;
  protocol: "artNet" | "sacn";
  /** 单播 / 广播（Art-Net）/ 组播（sACN，地址由远端 Universe 决定） */
  mode: "unicast" | "broadcast" | "multicast";
  /** 单播 / 广播目标 IP（组播时忽略） */
  ip: string;
  port: number;
  /** 远端 Universe：Art-Net 为 15 位 Port-Address（0~32767），sACN 为 1~63999 */
  remoteUniverse: number;
  /** sACN 优先级 0~200，省略为 100 */
  priority?: number;
  enabled: boolean;
}

/** 工程 Universe 表里的一项。 */
export interface UniverseConfig {
  /** 工程内的 Universe 编号（灯具配接用的编号），0 起 */
  universe: number;
  label: string;
  color?: Rgb;
  ports: UniversePort[];
}

/** 多 Universe 帧同步。 */
export interface SyncSettings {
  /** 每帧所有 ArtDmx 发完后发一个 ArtSync */
  artSync: boolean;
  /** sACN 同步 Universe（1~63999）；`null` 为不同步 */
  sacnSyncUniverse: number | null;
}

/** 通道锁定（Park）：无论节目如何，该通道始终输出固定值。 */
export interface ParkEntry {
  universe: number;
  /** 通道 1~512 */
  channel: number;
  /** 0~255 */
  value: number;
}

/** 输出设置。 */
export interface OutputSettings {
  target: OutputTarget;
  /** 播放到结尾后是否循环 */
  loop: boolean;
  /** 输出延迟补偿（毫秒）：用于对齐音视频与灯光 */
  latencyCompMs: number;
  /** Gamma，1.0 为线性 */
  gamma: number;
  /** Universe 路由表（目标为 `routed` 时使用；也用于显示 Universe 的名字和颜色） */
  universes: UniverseConfig[];
  sync: SyncSettings;
  park: ParkEntry[];
}

/** 舞台上的一个布景物件（桁架、形状、文字）。 */
export interface StageObject {
  id: string;
  kind: "truss" | "rect" | "circle" | "label";
  x: number;
  y: number;
  /** 宽 / 直径（米） */
  w: number;
  /** 高（米），圆形忽略 */
  h: number;
  rotation: number;
  label: string;
}

/** 舞台布置。 */
export interface StageLayout {
  /** 舞台宽度（米） */
  width: number;
  /** 舞台纵深（米） */
  depth: number;
  objects: StageObject[];
  /** 背景图（本地路径，只引用不复制） */
  backgroundPath: string | null;
}

/** 节目工程。 */
export interface ShowProject {
  version: typeof PROJECT_VERSION;
  name: string;
  notes: string;
  /** 节目总时长（毫秒） */
  durationMs: number;
  /** 所用灯具模型的快照 */
  fixtureModels: FixtureModel[];
  fixtures: FixtureInstance[];
  groups: FixtureGroup[];
  /** 素材库 */
  media: MediaRef[];
  /** 媒体轨道（时间线上方，从上到下；上面的视频盖住下面的） */
  mediaTracks: MediaTrack[];
  mediaClips: MediaClip[];
  tracks: Track[];
  cues: Cue[];
  markers: Marker[];
  tempo: Tempo | null;
  output: OutputSettings;
  presets: Preset[];
  sections: Section[];
  /** A-B 循环区间（编辑时反复播放一段）；`null` 为不循环 */
  loopRange: { startMs: number; endMs: number } | null;
  stage: StageLayout;
}

/** 新建工程的默认输出同步设置。 */
export const DEFAULT_SYNC: SyncSettings = { artSync: false, sacnSyncUniverse: null };

/** 新建工程的默认舞台：12 m × 8 m，没有物件。 */
export const DEFAULT_STAGE: StageLayout = { width: 12, depth: 8, objects: [], backgroundPath: null };

/** 新建工程的默认时长：3 分钟。 */
export const DEFAULT_DURATION_MS = 180_000;

/** 默认输出目标：Art-Net 广播。 */
export const DEFAULT_OUTPUT_TARGET: OutputTarget = {
  kind: "direct",
  ip: "255.255.255.255",
  protocol: "artNet",
  port: 6454,
};

/**
 * 新建空工程。
 *
 * @param name 工程名称。
 * @returns 没有灯具、轨道和 Cue 的空工程。
 */
export function createEmptyProject(name: string): ShowProject {
  return {
    version: PROJECT_VERSION,
    name,
    notes: "",
    durationMs: DEFAULT_DURATION_MS,
    fixtureModels: [],
    fixtures: [],
    groups: [],
    media: [],
    mediaTracks: [],
    mediaClips: [],
    tracks: [],
    cues: [],
    markers: [],
    tempo: null,
    output: {
      target: { ...DEFAULT_OUTPUT_TARGET },
      loop: false,
      latencyCompMs: 0,
      gamma: DEFAULT_GAMMA,
      universes: [],
      sync: { ...DEFAULT_SYNC },
      park: [],
    },
    presets: [],
    sections: [],
    loopRange: null,
    stage: structuredClone(DEFAULT_STAGE),
  };
}
