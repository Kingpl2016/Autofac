import type { FixtureModel } from "@/features/fixtures";

/**
 * 节目工程（`ShowProject`）的数据模型。
 *
 * - 时间一律用整数毫秒；输出节拍固定 30 FPS（见 [`OUTPUT_FPS`]）。
 * - 灯具模型在工程里保存一份快照（`fixtureModels`），素材库之后改动或换一台电脑打开都不影响已有节目。
 * - 工程文件格式带 `version`，不兼容的改动必须递增版本并提供迁移。
 */

/** 工程文件格式版本。 */
export const PROJECT_VERSION = 1;

/** 输出帧率（固定）。 */
export const OUTPUT_FPS = 30;

/** 一个 Universe 的 DMX 通道数。 */
export const DMX_CHANNELS = 512;

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
}

/** 灯具分组：成员顺序决定特效沿灯具推进时的先后。 */
export interface FixtureGroup {
  id: string;
  name: string;
  fixtureIds: string[];
}

/** 轨道绑定的对象：一个灯具或一个分组。 */
export type TrackTarget = { kind: "fixture"; id: string } | { kind: "group"; id: string };

/** 时间线轨道。轨道名取自它绑定的灯具 / 分组，不单独保存。 */
export interface Track {
  id: string;
  target: TrackTarget;
  mute: boolean;
  solo: boolean;
  lock: boolean;
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
}

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

/** 时间线上的 Cue。 */
export type Cue = StaticCue | EffectCue;

/** 音视频素材引用（只记录路径，不复制进工程）。 */
export interface MediaRef {
  id: string;
  kind: "audio" | "video";
  path: string;
  name: string;
  durationMs: number;
  /** 素材起点相对时间线 0 点的偏移（毫秒，可为负） */
  offsetMs: number;
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

/** 输出目标（与后端 `DispatchTarget` 的序列化形态一致）。 */
export type OutputTarget =
  | { kind: "forwarding" }
  | { kind: "direct"; ip: string; protocol: "artNet" | "sacn"; port: number };

/** 输出设置。 */
export interface OutputSettings {
  target: OutputTarget;
  /** 播放到结尾后是否循环 */
  loop: boolean;
  /** 输出延迟补偿（毫秒）：用于对齐音视频与灯光 */
  latencyCompMs: number;
  /** Gamma，1.0 为线性 */
  gamma: number;
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
  media: MediaRef[];
  tracks: Track[];
  cues: Cue[];
  markers: Marker[];
  tempo: Tempo | null;
  output: OutputSettings;
}

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
    tracks: [],
    cues: [],
    markers: [],
    tempo: null,
    output: {
      target: { ...DEFAULT_OUTPUT_TARGET },
      loop: false,
      latencyCompMs: 0,
      gamma: 2.2,
    },
  };
}
