import type { FixtureModel } from "@/features/fixtures";
import type { EffectDef, EffectParams } from "./effectDefSchema";

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
 * - v4：像素引用：分组成员、灯具轨道与场景条目可以引用多头 / 像素灯的单个像素（`灯具id#像素号`，见 `fixtureRef.ts`）。
 *   结构不变，v3 文件原样升级；递增版本是为了让旧版软件打开新文件时提示“文件来自新版本”。
 * - v5：三维舞台：灯具的俯仰安装角（`stage.pitch`）、舞台台面高度（`stage.height`）、布景物件的离地高度与自身高度
 *   （`z` / `height`）；灯具模型快照可带外观（外形模板、图标、3D 模型引用）与更多物理参数。
 *   新字段都可省略，v4 文件原样升级。
 * - v6：舞台增强：新的布景类型（LED 屏、台阶、立柱、多边形台面，带 `points` / `steps` / `content`）、
 *   烟雾浓度（`stage.haze`）与场馆模型（`stage.venue`）；图案槽位可指定图案（模型快照里的 `capabilities[].pattern`）。
 *   新字段都可省略，v5 文件原样升级。
 */
export const PROJECT_VERSION = 6;

/** 输出帧率（固定）。 */
export const OUTPUT_FPS = 30;

/** 分组的最少成员数。 */
export const MIN_GROUP_SIZE = 2;

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
  /**
   * 俯仰安装角（度，-90~90，省略为 0）：灯体绕自身左右轴转动，正值让光轴（站立朝上、吊挂朝下）朝水平朝向倾斜。
   * 例如吊挂的面光朝向 180°（打向舞台）、俯仰 45°，光束斜着落到台面上。只影响 3D 舞台的显示与光束方向。
   */
  pitch?: number;
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

/** 轨道自定义高度（拖动轨道头下边缘）的范围（像素）。 */
export const TRACK_HEIGHT_PX = { min: 24, max: 160 } as const;

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
  /** 拖动轨道头下边缘得到的自定义高度（像素，24~160）；有值时优先于 `height` */
  heightPx?: number;
  /** 置顶层：颜色 / 属性在所有其它轨道之后应用（编辑器的编程器预览用，与后端 `Track::on_top` 一致） */
  onTop?: boolean;
  /**
   * 轨道用途：`accent` 为重音层（AI 按音乐事件放的冲击 / 换色片段，叠在同一目标的主轨道之上）。
   * 省略即普通轨道；引擎不读这个字段（多条轨道本来就按强度取最大、颜色后来者优先合成）。
   */
  role?: "accent";
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

/**
 * 数值曲线的形状。`noise` 为平滑噪声（相邻随机值之间插值），`steps` 为自定义步进（见 {@link ValueCurve.steps}）。
 */
export type WaveShape = "sine" | "triangle" | "saw" | "square" | "ramp" | "random" | "noise" | "steps";

/** 周期：毫秒，或按 BPM 的拍数。 */
export type Period = { kind: "ms"; ms: number } | { kind: "beats"; beats: number };

/** 周期的相位起点：片段起点（默认），或按节拍网格对齐。 */
export type CurveSync = "clip" | "beat";

/** 周期计时（数值曲线与颜色序列共用）。 */
export interface CycleTiming {
  /** 片段内的循环次数，至少 1；有 `period` 时忽略 */
  cycles: number;
  /** 按时间计的周期：与片段长度无关，按拍时跟随工程节拍 */
  period?: Period;
  /** 相位起点，省略为 `clip` */
  sync?: CurveSync;
  /** 起始相位 0~1 */
  phase: number;
  /** 过渡占周期（步进 / 颜色序列为每一步）的比例 0~1，余下时间保持；省略为 1 */
  transition?: number;
  /** 过渡的缓动；省略时按形状本身（步进为保持、噪声为 S 曲线、颜色序列为线性） */
  ease?: Curve;
}

/** 数值曲线：在片段时长内按形状在 `from` 与 `to` 之间变化，可重复多次。 */
export interface ValueCurve extends CycleTiming {
  shape: WaveShape;
  from: number;
  to: number;
  /** 方波的占空比 0~1 */
  duty?: number;
  /** 步进波形每一步的值（0~1，乘到 `from`→`to` 区间上） */
  steps?: number[];
  /** 随机 / 噪声的种子：给出时每台灯的序列各不相同 */
  seed?: number;
}

/** 一组颜色之间的过渡方式：平滑、跳变、按色相（沿色轮）。 */
export type ColorBlend = "smooth" | "step" | "hue";

/** 颜色序列：每个周期依次走过一组颜色（首尾相接），受多灯相位分布影响。 */
export interface ColorCycle extends CycleTiming {
  colors: ColorValue[];
  /** 省略为 `smooth` */
  blend?: ColorBlend;
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
  color?: ColorParam;
  /** 其它属性，0~1 DMX 分数 */
  attrs?: Partial<Record<AttrKey, Param<number>>>;
  /** 引用的预设：预设的各层作为底，本外观里显式写出的层覆盖它 */
  presetId?: string;
}

/** 序列参数：每个周期依次走过一组值（目前只用于颜色）。 */
export type CycleParam<T> = { kind: "cycle"; cycle: CycleTiming & { colors: T[]; blend?: ColorBlend } };

/** 颜色参数：固定值、关键帧，或颜色序列（{@link ColorCycle}）。 */
export type ColorParam = Param<ColorValue> | CycleParam<ColorValue>;

/** 只作用于某一层的相位偏移键。 */
export type PhaseKey = `phase.${"intensity" | "color" | AttrKey}`;

/**
 * 分布里可以展开的量：强度、色相偏移（度）、数值曲线的相位偏移（周期的分数，`phase` 作用于全部层，
 * `phase.<层>` 只作用于那一层）或某个属性。
 */
export type SpreadKey = "intensity" | "hue" | "phase" | PhaseKey | AttrKey;

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
  /** 成块：连续 n 台取同样的值 */
  blocks?: number;
  /** 分组：每 n 个位置重复一遍分布 */
  groups?: number;
  /** 打乱顺序的种子 */
  shuffle?: number;
  /** 静态颜色分布：沿成员铺开一组颜色（覆盖外观的颜色层） */
  colors?: { colors: ColorValue[]; blend?: ColorBlend };
}

/** 属性分层片段：在轨道（灯具 / 分组）上显示一个外观，可带分布。 */
export interface LookClip extends CueBase {
  kind: "look";
  look: Look;
  spread?: Spread;
  /** 片段的名称（时间线上显示；Cue 模板 / 属性特效放下时写入，可在属性面板里改；不影响输出） */
  label?: string;
  /**
   * 特效快照：由属性特效生成的片段记住特效定义与参数，插入后仍可改参数（重新生成 `look` / `spread`）。
   * 手动编辑外观层或分布时删除（片段变成普通外观）。只给编辑器用，引擎不读它。
   */
  fx?: { def: EffectDef; params: EffectParams };
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

/**
 * 布景物件的类型：桁架、矩形平台、圆台、文字，以及 LED 屏、台阶、立柱 / 灯架、多边形台面。
 */
export const STAGE_OBJECT_KINDS = ["truss", "rect", "circle", "label", "screen", "stairs", "pillar", "polygon"] as const;

/** 布景物件的类型。 */
export type StageObjectKind = (typeof STAGE_OBJECT_KINDS)[number];

/** LED 屏显示的内容：工程里的视频素材（与时间线同步），或一台像素灯的实时输出。 */
export type ScreenContent = { kind: "media"; mediaId: string } | { kind: "fixture"; fixtureId: string };

/** 场馆模型（资源库里的 GLB，作为 3D 舞台的背景）。 */
export interface StageVenue {
  /** 资源散列 */
  hash: string;
  /** 原始文件名（显示用） */
  name: string;
  /** 模型原点在舞台坐标里的位置（米） */
  x: number;
  y: number;
  z: number;
  /** 绕竖直轴的角度（度） */
  rotation: number;
  /** 整体缩放（1 为原尺寸） */
  scale: number;
}

/**
 * 舞台上的一个布景物件。
 *
 * 各类型的尺寸含义：LED 屏 `w` 为屏宽、`h` 为屏体厚度、`height` 为屏高，旋转 0 时屏面朝观众（-y）；
 * 台阶 `w` 为宽、`h` 为进深、`height` 为总高，旋转 0 时前低后高；立柱 `w` 为直径；
 * 多边形台面的 `w` / `h` 为顶点的包围盒（由顶点算出）。
 */
export interface StageObject {
  id: string;
  kind: StageObjectKind;
  x: number;
  y: number;
  /** 宽 / 直径（米） */
  w: number;
  /** 平面上的纵深（米，俯视图里的“高”），圆形 / 立柱忽略 */
  h: number;
  rotation: number;
  label: string;
  /** 离地高度（米，物件底面；省略为 0）：例如吊在 6 米的桁架 */
  z?: number;
  /** 自身高度（米，竖直方向的厚度；省略时按类型取默认值，见 `objectHeight`） */
  height?: number;
  /** 多边形台面的顶点（米，相对物件中心、旋转前的本地坐标，3~64 个） */
  points?: [number, number][];
  /** 台阶的级数（省略为 4） */
  steps?: number;
  /** LED 屏的内容（省略时黑屏） */
  content?: ScreenContent;
}

/** 舞台布置。 */
export interface StageLayout {
  /** 舞台宽度（米） */
  width: number;
  /** 舞台纵深（米） */
  depth: number;
  /** 台面高度（米，高出观众区地面；省略为 0）：3D 舞台画出台体，灯具高度从台面算起 */
  height?: number;
  /** 烟雾浓度（0~1，省略为 0.35）：3D 舞台里光束的可见程度 */
  haze?: number;
  /** 场馆模型（3D 舞台的背景） */
  venue?: StageVenue;
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
