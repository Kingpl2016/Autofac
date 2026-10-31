import type { BeamQuality } from "../stores/useEditorPrefsStore";

/**
 * 光束画质档位与自动调节（纯逻辑）。
 *
 * - 高：所有亮着的光束都画体积光（烟雾里能看到图案与明暗）。
 * - 中：最亮的 {@link MID_VOLUMETRIC} 束画体积光，其余画简单光锥。
 * - 低：全部画简单光锥。
 * - 自动：播放时按帧间隔调节——持续 2 秒超过 40 毫秒降一档，持续 5 秒低于 20 毫秒升一档（两个阈值之间不动，避免来回跳）。
 *
 * 暂停或拖动播放头时画面不会每秒重画几十次，渲染器按高一档的采样数画（更细腻）。
 */

/** 实际使用的档位。 */
export type BeamTier = Exclude<BeamQuality, "auto">;

/** 中档画体积光的光束数。 */
export const MID_VOLUMETRIC = 32;

/** 帧间隔超过它算“慢”（毫秒）。 */
const SLOW_MS = 40;
/** 帧间隔低于它算“快”（毫秒）。 */
const FAST_MS = 20;
/** 持续慢多久降档（毫秒）。 */
const DROP_AFTER_MS = 2000;
/** 持续快多久升档（毫秒）。 */
const RAISE_AFTER_MS = 5000;
/** 帧间隔超过它视为卡顿或后台（不计入，毫秒）。 */
const GAP_MS = 500;

const ORDER: readonly BeamTier[] = ["low", "mid", "high"];

/**
 * 自动画质的调节器：喂入每帧的间隔，返回当前档位。
 */
export class QualityGovernor {
  #tier: BeamTier;
  #slowSince: number | null = null;
  #fastSince: number | null = null;

  /**
   * @param initial 初始档位。
   */
  constructor(initial: BeamTier = "mid") {
    this.#tier = initial;
  }

  /** 当前档位。 */
  get tier(): BeamTier {
    return this.#tier;
  }

  /**
   * 记录一帧。
   *
   * @param intervalMs 与上一帧的间隔（毫秒）。
   * @param nowMs 当前时间（毫秒，单调递增）。
   * @returns 档位是否变化。
   */
  sample(intervalMs: number, nowMs: number): boolean {
    if (!(intervalMs > 0) || intervalMs > GAP_MS) {
      this.#slowSince = this.#fastSince = null;
      return false;
    }
    if (intervalMs > SLOW_MS) {
      this.#fastSince = null;
      this.#slowSince ??= nowMs;
      if (nowMs - this.#slowSince >= DROP_AFTER_MS) return this.#shift(-1);
    } else if (intervalMs < FAST_MS) {
      this.#slowSince = null;
      this.#fastSince ??= nowMs;
      if (nowMs - this.#fastSince >= RAISE_AFTER_MS) return this.#shift(1);
    } else {
      this.#slowSince = this.#fastSince = null;
    }
    return false;
  }

  #shift(step: number): boolean {
    this.#slowSince = this.#fastSince = null;
    const i = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(this.#tier) + step));
    if (ORDER[i] === this.#tier) return false;
    this.#tier = ORDER[i];
    return true;
  }
}

/**
 * 实际使用的档位。
 *
 * @param quality 用户选择。
 * @param auto 自动调节器的当前档位。
 * @returns 档位。
 */
export function effectiveTier(quality: BeamQuality, auto: BeamTier): BeamTier {
  return quality === "auto" ? auto : quality;
}

/**
 * 体积光的步进采样数。
 *
 * @param tier 档位。
 * @param still 画面静止（暂停 / 拖动播放头）时按高一档。
 * @returns 每条光线的采样数；低档为 0（不画体积光）。
 */
export function marchSteps(tier: BeamTier, still: boolean): number {
  const t = still ? ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + 1)] : tier;
  return t === "high" ? 28 : t === "mid" ? 14 : 0;
}

/**
 * 画体积光的光束数上限。
 *
 * @param tier 档位。
 * @param still 画面静止。
 * @returns 上限；低档为 0。
 */
export function volumetricBudget(tier: BeamTier, still: boolean): number {
  if (tier === "low" && !still) return 0;
  if (tier === "high" || (tier === "mid" && still)) return Number.POSITIVE_INFINITY;
  return MID_VOLUMETRIC;
}
