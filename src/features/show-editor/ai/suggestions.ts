import { eventsIn, type TimelineAnalysis } from "../lib/mediaAnalysis";
import type { Cue, ShowProject } from "../lib/project";
import type { Phrase } from "./askScope";
import type { RecipeId } from "./recipes";

/**
 * 时间线上的主动建议（纯函数，按规则给出，不调用模型）：
 *
 * - `fillSection`：分析出的段落里还没有灯光 → 按段落能量建议一个配方；
 * - `accentHits`：高能段落里有冲击、但没有重音 → 建议在冲击上放重音；
 * - `colorCuts`：视频有镜头切换、切换处颜色没有变化 → 建议在切换处换色；
 * - `varyLooks`：同一轨道上连续几个片段完全一样 → 建议交替调暗做出层次。
 *
 * 建议只给出操作（AiOps），写入前和模型的提议一样经编译器试运行；同样的工程与分析总是同样的建议。
 * 每条建议有稳定的键（规则 + 位置），忽略过的不再出现。
 */

/** 建议的规则。 */
export type SuggestionRule = "fillSection" | "accentHits" | "colorCuts" | "varyLooks";

/** 一条建议。 */
export interface Suggestion {
  /** 稳定的键（忽略记录用）：规则 + 起点（取整到 100 毫秒）+ 轨道 */
  id: string;
  rule: SuggestionRule;
  startMs: number;
  endMs: number;
  /** 作用的轨道（`varyLooks`）；其它为 `null` */
  trackId: string | null;
  /** 要执行的操作（未经 schema 解析的 AiOps） */
  ops: Record<string, unknown>[];
  /** 说明 */
  text: Phrase;
  /** “让 AI 细化”时发给模型的话 */
  refine: Phrase;
}

/** 段落至少多长才建议编排（毫秒）。 */
const MIN_SECTION_MS = 4000;
/** 高能段落的能量下限。 */
const HIGH_ENERGY = 0.6;
/** 一段里至少几个冲击才建议重音。 */
const MIN_HITS = 4;
/** 至少几个镜头切换才建议换色。 */
const MIN_CUTS = 3;
/** 判断“切换处已有变化”的容差（毫秒）。 */
const CUT_TOLERANCE_MS = 150;
/** 连续几个一样的片段才建议变化。 */
const MIN_RUN = 3;
/** 相邻片段之间最多隔多久仍算连续（毫秒）。 */
const RUN_GAP_MS = 100;
/** 最多给出多少条建议。 */
export const MAX_SUGGESTIONS = 12;

/** 时间引用（秒，最多 3 位小数）。 */
const sec = (ms: number) => `${Math.round(ms) / 1000}s`;
/** 建议的键。 */
const keyOf = (rule: SuggestionRule, startMs: number, trackId: string | null = null) =>
  `${rule}@${Math.round(startMs / 100) * 100}${trackId ? `#${trackId}` : ""}`;

/**
 * 按段落能量选配方。
 *
 * @param energy 能量 0~1。
 * @returns 配方 id。
 */
export function recipeForEnergy(energy: number): RecipeId {
  if (energy >= 0.66) return "chorusBurst";
  if (energy >= 0.33) return "verseGroove";
  return "balladBed";
}

/** 片段的内容（去掉位置、id 与标签），用来判断两个片段是否一样。 */
function contentOf(cue: Cue): string {
  const { id: _id, startMs: _s, endMs: _e, tag: _t, trackId: _tr, ...rest } = cue;
  return JSON.stringify(rest);
}

/**
 * 主动建议。
 *
 * @param project 工程。
 * @param analysis 主素材的分析（没有时只给 `varyLooks`）。
 * @param dismissed 忽略过的建议键。
 * @returns 建议（按起点排序，最多 {@link MAX_SUGGESTIONS} 条）。
 */
export function suggestTimeline(project: ShowProject, analysis: TimelineAnalysis | null, dismissed: readonly string[]): Suggestion[] {
  const out: Suggestion[] = [];
  const accentIds = new Set(project.tracks.filter((t) => t.role === "accent").map((t) => t.id));
  const lightTracks = project.tracks.filter((t) => t.role !== "accent" && t.target.kind !== "scene");
  if (lightTracks.length === 0) return [];
  const baseCues = project.cues.filter((c) => !accentIds.has(c.trackId));
  const accentCues = project.cues.filter((c) => accentIds.has(c.trackId));
  const overlaps = (list: readonly Cue[], a: number, b: number) => list.some((c) => c.endMs > a && c.startMs < b);
  const end = project.durationMs;

  if (analysis) {
    for (const s of analysis.sections) {
      const startMs = Math.max(0, s.startMs);
      const endMs = Math.min(end, s.endMs);
      if (endMs - startMs < MIN_SECTION_MS) continue;
      const empty = !overlaps(baseCues, startMs, endMs);
      if (empty) {
        const recipe = recipeForEnergy(s.energy);
        out.push({
          id: keyOf("fillSection", startMs),
          rule: "fillSection",
          startMs,
          endMs,
          trackId: null,
          ops: [{ op: "applyRecipe", recipe, target: "all", from: sec(startMs), to: sec(endMs) }],
          text: { key: "editor.suggest.fillSection", args: { recipe: `editor.suggest.recipes.${recipe}` } },
          refine: { key: "editor.suggest.refine.fillSection" },
        });
        continue;
      }
      const hits = eventsIn(analysis, ["hit", "drop"], startMs, endMs);
      if (s.energy >= HIGH_ENERGY && hits.length >= MIN_HITS && !overlaps(accentCues, startMs, endMs)) {
        out.push({
          id: keyOf("accentHits", startMs),
          rule: "accentHits",
          startMs,
          endMs,
          trackId: null,
          ops: [{ op: "placeAccents", events: "hits", target: "all", from: sec(startMs), to: sec(endMs) }],
          text: { key: "editor.suggest.accentHits", args: { count: hits.length } },
          refine: { key: "editor.suggest.refine.accentHits" },
        });
      }
    }

    // 镜头切换：切换处既没有新片段开始，也没有重音
    const cuts = analysis.events.filter((e) => e.kind === "cut" && e.atMs < end);
    if (cuts.length >= MIN_CUTS) {
      const changed = (at: number) => project.cues.some((c) => Math.abs(c.startMs - at) <= CUT_TOLERANCE_MS);
      const missing = cuts.filter((c) => !changed(c.atMs));
      if (missing.length >= MIN_CUTS && overlaps(baseCues, missing[0].atMs, missing.at(-1)!.atMs + 1)) {
        const startMs = missing[0].atMs;
        const last = analysis.shots.find((s) => s.startMs >= missing.at(-1)!.atMs - 1);
        const endMs = Math.min(end, Math.max(missing.at(-1)!.atMs + 1000, last?.endMs ?? 0));
        out.push({
          id: keyOf("colorCuts", startMs),
          rule: "colorCuts",
          startMs,
          endMs,
          trackId: null,
          ops: [{ op: "placeAccents", events: "cuts", target: "all", from: sec(startMs), to: sec(endMs), fromVideo: analysis.shots.length > 0 }],
          text: { key: "editor.suggest.colorCuts", args: { count: missing.length } },
          refine: { key: "editor.suggest.refine.colorCuts" },
        });
      }
    }
  }

  // 连续一样的片段：交替调暗
  for (const track of lightTracks) {
    const cues = baseCues.filter((c) => c.trackId === track.id && (c.kind === "static" || c.kind === "look")).sort((a, b) => a.startMs - b.startMs);
    let i = 0;
    while (i < cues.length) {
      let j = i + 1;
      while (j < cues.length && cues[j].startMs - cues[j - 1].endMs <= RUN_GAP_MS && cues[j].startMs >= cues[j - 1].endMs - RUN_GAP_MS && contentOf(cues[j]) === contentOf(cues[i])) j += 1;
      if (j - i >= MIN_RUN) {
        const run = cues.slice(i, j);
        const alternate = run.filter((_, k) => k % 2 === 1).map((c) => c.id);
        const brightness = run[0].brightness >= 80 ? 60 : 100;
        out.push({
          id: keyOf("varyLooks", run[0].startMs, track.id),
          rule: "varyLooks",
          startMs: run[0].startMs,
          endMs: run.at(-1)!.endMs,
          trackId: track.id,
          // 片段用真实 id 记下，执行前换成别名（见 `suggestionOps`）
          ops: [{ op: "editCues", cues: alternate, brightness }],
          text: { key: "editor.suggest.varyLooks", args: { count: run.length } },
          refine: { key: "editor.suggest.refine.varyLooks" },
        });
      }
      i = j;
    }
  }

  const skip = new Set(dismissed);
  return out
    .filter((s) => !skip.has(s.id))
    .sort((a, b) => a.startMs - b.startMs || a.rule.localeCompare(b.rule))
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * 建议的操作：片段 id 换成别名（编译器按别名解析）。
 *
 * @param s 建议。
 * @param toAlias 真实 id → 别名。
 * @returns 操作；引用的片段已不存在时为 `null`。
 */
export function suggestionOps(s: Suggestion, toAlias: ReadonlyMap<string, string>): { summary: string; ops: Record<string, unknown>[] } | null {
  const ops: Record<string, unknown>[] = [];
  for (const op of s.ops) {
    if (Array.isArray(op.cues)) {
      const aliases = (op.cues as string[]).map((id) => toAlias.get(id));
      if (aliases.some((a) => !a)) return null;
      ops.push({ ...op, cues: aliases });
    } else ops.push(op);
  }
  return { summary: s.rule, ops };
}

/**
 * 画面上同时显示的建议：在可见时间范围里的，最多 `limit` 条（离播放头近的优先，再按时间排）。
 *
 * @param list 全部建议。
 * @param fromMs 可见范围起点。
 * @param toMs 可见范围终点。
 * @param playheadMs 播放头。
 * @param limit 上限。
 * @returns 建议（按起点排序）。
 */
export function visibleSuggestions(list: readonly Suggestion[], fromMs: number, toMs: number, playheadMs: number, limit = 3): Suggestion[] {
  const dist = (s: Suggestion) => (playheadMs < s.startMs ? s.startMs - playheadMs : playheadMs > s.endMs ? playheadMs - s.endMs : 0);
  return list
    .filter((s) => s.endMs > fromMs && s.startMs < toMs)
    .sort((a, b) => dist(a) - dist(b) || a.startMs - b.startMs)
    .slice(0, limit)
    .sort((a, b) => a.startMs - b.startMs);
}
