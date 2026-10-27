import type { Transport } from "./playbackApi";

/**
 * 音视频与后端时钟的同步策略（纯函数，便于测试）。
 *
 * 后端是播放的主时钟，素材元素（`<audio>` / `<video>`）只是跟随者。每次收到后端的位置，
 * 按元素当前播放时间与目标时间的偏差决定动作：
 *
 * - 偏差在 {@link DRIFT_OK_MS} 以内：不动；
 * - 偏差在 {@link DRIFT_OK_MS} 到 {@link DRIFT_SEEK_MS} 之间：微调 `playbackRate`（最多 ±5%）慢慢追平，听感上无跳变；
 * - 偏差超过 {@link DRIFT_SEEK_MS}：直接跳到目标位置。
 */

/** 偏差小于此值（毫秒）视为同步。 */
export const DRIFT_OK_MS = 30;

/** 偏差大于此值（毫秒）直接跳转，不再用变速追平。 */
export const DRIFT_SEEK_MS = 200;

/** 变速追平时的最大速率偏离（±5%）。 */
export const MAX_RATE_DEVIATION = 0.05;

/** 暂停 / 拖动播放头时，元素位置与目标偏差超过此值（毫秒）才重新定位，避免对同一位置反复 seek。 */
export const SCRUB_TOLERANCE_MS = 40;

/** 同步所需的输入。时间单位均为毫秒。 */
export interface SyncInput {
  /** 后端传输状态 */
  transport: Transport;
  /** 后端播放位置（时间线时间） */
  positionMs: number;
  /** 素材 0 点在时间线上的位置（片段起点 − 入点） */
  offsetMs: number;
  /** 可播放范围的终点（素材内时刻：入点 + 片段长度；整段素材时为素材时长） */
  mediaDurationMs: number;
  /** 可播放范围的起点（素材内时刻：片段入点），省略为 0 */
  rangeStartMs?: number;
  /** 元素当前播放时间 */
  currentTimeMs: number;
  /** 元素当前是否暂停 */
  elementPaused: boolean;
}

/** 同步动作。 */
export interface SyncPlan {
  /** 需要开始播放 */
  play: boolean;
  /** 需要暂停 */
  pause: boolean;
  /** 需要跳转到的素材内时刻；`null` 表示不跳 */
  seekToMs: number | null;
  /** 应设置的播放速率 */
  rate: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 计算一个素材元素此刻该做什么。
 *
 * @param input 后端状态与元素状态。
 * @returns 要执行的动作；调用方负责把动作应用到元素上。
 */
export function planSync(input: SyncInput): SyncPlan {
  const target = input.positionMs - input.offsetMs;
  const first = Math.max(0, input.rangeStartMs ?? 0);
  const last = Math.max(first, input.mediaDurationMs);
  const clamped = clamp(target, first, last);

  if (input.transport !== "playing") {
    // 暂停 / 停止：停住并对齐到目标位置（拖动播放头时视频随之显示对应画面）
    const off = Math.abs(input.currentTimeMs - clamped) > SCRUB_TOLERANCE_MS;
    return { play: false, pause: !input.elementPaused, seekToMs: off ? clamped : null, rate: 1 };
  }

  // 播放中，但素材还没开始或已经结束：停在端点，等时间线走到素材范围内
  if (target < first || target >= last) {
    const atEdge = Math.abs(input.currentTimeMs - clamped) <= SCRUB_TOLERANCE_MS;
    return { play: false, pause: !input.elementPaused, seekToMs: atEdge ? null : clamped, rate: 1 };
  }

  if (input.elementPaused) {
    return { play: true, pause: false, seekToMs: target, rate: 1 };
  }

  const drift = input.currentTimeMs - target; // 正数：元素跑在前面
  const size = Math.abs(drift);
  if (size > DRIFT_SEEK_MS) return { play: false, pause: false, seekToMs: target, rate: 1 };
  if (size <= DRIFT_OK_MS) return { play: false, pause: false, seekToMs: null, rate: 1 };
  const rate = clamp(1 - drift / 1000, 1 - MAX_RATE_DEVIATION, 1 + MAX_RATE_DEVIATION);
  return { play: false, pause: false, seekToMs: null, rate };
}

/** 扩展名对应的 MIME 类型，用于 `canPlayType` 探测。 */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

/**
 * 当前 webview 能否播放这个扩展名的素材。
 *
 * 只是个预判：`canPlayType` 返回空串表示肯定不能播放；返回 `maybe` / `probably` 时按能播放处理。
 *
 * @param extension 扩展名（小写，不含点）。
 * @param probe 创建一个媒体元素用来探测；测试里可替换。
 * @returns 可能可以播放时为 `true`。
 */
export function canPlayExtension(
  extension: string,
  probe: (kind: "audio" | "video") => Pick<HTMLMediaElement, "canPlayType"> = (kind) =>
    document.createElement(kind),
): boolean {
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) return false;
  const kind = mime.startsWith("video") ? "video" : "audio";
  return probe(kind).canPlayType(mime) !== "";
}
