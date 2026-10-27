import { sampleEffect } from "./effects";
import type { Cue, CueBase, Easing, Rgb, ShowProject } from "./project";

/**
 * 预览用的颜色求值。
 *
 * 真正的 DMX 输出由后端 `show-engine` 计算；这里只镜像“静态 Cue / 特效 + 淡入淡出缓动 + Gamma + HTP”，
 * 用来在界面上画灯具色块。公式与后端逐一对应，并共用
 * `__tests__/golden/show-eval.json` 黄金向量保证两边一致。
 */

/** 把进度映射到缓动曲线上。 */
export function ease(easing: Easing, x: number): number {
  const v = Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x));
  switch (easing) {
    case "linear":
      return v;
    case "easeInOut": {
      if (v < 0.5) return 4 * v * v * v;
      const k = -2 * v + 2;
      return 1 - (k * k * k) / 2;
    }
    case "sCurve":
      return v * v * (3 - 2 * v);
  }
}

/**
 * Cue 在 `tMs` 的淡入淡出包络，范围 0~1；区间 `[startMs, endMs)` 外为 0。
 * 淡入淡出重叠时取较小者。
 */
export function envelope(cue: CueBase, tMs: number): number {
  if (tMs < cue.startMs || tMs >= cue.endMs) return 0;
  const up = cue.fadeInMs > 0 ? ease(cue.easing, (tMs - cue.startMs) / cue.fadeInMs) : 1;
  const down = cue.fadeOutMs > 0 ? ease(cue.easing, (cue.endMs - tMs) / cue.fadeOutMs) : 1;
  return Math.min(up, down);
}

/** 规整 Gamma：非有限或非正数按线性处理，并限制在 0.1~5。 */
export function sanitizeGamma(gamma: number): number {
  return Number.isFinite(gamma) && gamma > 0 ? Math.min(5, Math.max(0.1, gamma)) : 1;
}

/** 对 0~1 的线性分数应用 Gamma。 */
export function applyGamma(v: number, gamma: number): number {
  const x = Math.min(1, Math.max(0, v));
  return Math.abs(gamma - 1) < Number.EPSILON ? x : Math.pow(x, gamma);
}

/** 预览求值器：给定时刻，返回每台灯具当前显示的颜色。 */
export type PreviewEvaluator = (tMs: number) => Map<string, Rgb>;

/** 同一轨道回溯检查的 Cue 数（与后端一致，仅作异常工程的容错）。 */
const LOOKBACK = 8;

interface PreviewTrack {
  fixtureIds: string[];
  cues: Cue[];
}

/**
 * 为工程创建预览求值器。
 *
 * 编译只做一次（展开轨道绑定、静音 / 独奏、按起点排序）；之后每次调用只需二分定位活动 Cue，
 * 适合以 30 FPS 反复调用。工程变化时需要重新创建。
 *
 * @param project 要预览的工程。
 * @returns 求值函数；返回的 Map 每次调用都是新对象，键为灯具实例 id（含黑色灯具）。
 */
export function createPreviewEvaluator(project: ShowProject): PreviewEvaluator {
  const gamma = sanitizeGamma(project.output.gamma);
  const tempo = project.tempo;
  const known = new Set(project.fixtures.map((f) => f.id));
  const groups = new Map(project.groups.map((g) => [g.id, g.fixtureIds]));
  const anySolo = project.tracks.some((t) => t.solo);

  const cuesByTrack = new Map<string, Cue[]>();
  for (const cue of project.cues) {
    if (cue.endMs <= cue.startMs) continue;
    const list = cuesByTrack.get(cue.trackId);
    if (list) list.push(cue);
    else cuesByTrack.set(cue.trackId, [cue]);
  }

  const tracks: PreviewTrack[] = [];
  for (const t of project.tracks) {
    if (anySolo ? !t.solo : t.mute) continue;
    const ids = t.target.kind === "fixture" ? [t.target.id] : (groups.get(t.target.id) ?? []);
    const cues = (cuesByTrack.get(t.id) ?? []).slice().sort((a, b) => a.startMs - b.startMs);
    tracks.push({ fixtureIds: ids.filter((id) => known.has(id)), cues });
  }

  return (tMs) => {
    const acc = new Map<string, [number, number, number]>();
    for (const f of project.fixtures) acc.set(f.id, [0, 0, 0]);

    for (const track of tracks) {
      const upper = upperBound(track.cues, tMs);
      for (let i = Math.max(0, upper - LOOKBACK); i < upper; i += 1) {
        const cue = track.cues[i];
        const env = envelope(cue, tMs);
        if (env <= 0) continue;
        const level = Math.min(1, Math.max(0, cue.brightness / 100)) * env;
        if (cue.kind === "static") {
          for (const id of track.fixtureIds) {
            const slot = acc.get(id);
            if (slot) mergeColor(slot, [cue.rgb[0] / 255, cue.rgb[1] / 255, cue.rgb[2] / 255], level);
          }
        } else {
          const lo = Math.min(cue.range[0], cue.range[1]);
          const hi = Math.max(cue.range[0], cue.range[1]);
          const low = Math.min(100, Math.max(0, lo)) / 100;
          const high = Math.min(100, Math.max(0, hi)) / 100;
          const count = track.fixtureIds.length;
          track.fixtureIds.forEach((id, index) => {
            const slot = acc.get(id);
            if (!slot) return;
            const s = sampleEffect(cue, tempo, tMs - cue.startMs, index, count);
            mergeColor(slot, s.rgb, level * (low + (high - low) * s.modulation));
          });
        }
      }
    }

    const out = new Map<string, Rgb>();
    for (const [id, [r, g, b]] of acc) {
      out.set(id, [toByte(r, gamma), toByte(g, gamma), toByte(b, gamma)]);
    }
    return out;
  };
}

/** 把颜色按亮度级别并入灯具的累加槽（HTP：每个分量取较大者）。 */
function mergeColor(slot: [number, number, number], rgb: [number, number, number], level: number): void {
  for (let c = 0; c < 3; c += 1) {
    const v = rgb[c] * level;
    if (v > slot[c]) slot[c] = v;
  }
}

/** 第一个起点大于 `tMs` 的下标（即起点 ≤ `tMs` 的 Cue 个数）。 */
function upperBound(cues: Cue[], tMs: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].startMs <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toByte(frac: number, gamma: number): number {
  return Math.round(applyGamma(frac, gamma) * 255);
}
