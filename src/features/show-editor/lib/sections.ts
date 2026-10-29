import { newId } from "./ids";
import { mediaClipEndMs } from "./mediaClips";
import type { BeatAnalysis } from "./mediaApi";
import { setTempo } from "./ops";
import type { MediaClip, Rgb, Section, ShowProject, Tempo } from "./project";
import { clamp } from "@/shared/lib/math";

/**
 * 歌曲段落（前奏 / 主歌 / 副歌…）的编辑，以及把后端的节拍分析结果换算到时间线上（速度网格 + 段落）。
 *
 * 编辑操作在 immer 草稿上执行；段落按起点排序、彼此不重叠。
 */

/** 段落最短长度（毫秒）。 */
export const MIN_SECTION_MS = 500;

/** 能量档位：安静 / 中等 / 高能。 */
export type EnergyTier = "low" | "mid" | "high";

/** 各能量档位的段落颜色（存进工程的数据色，不是界面主题色）。 */
export const TIER_COLORS: Record<EnergyTier, Rgb> = {
  low: [70, 120, 220],
  mid: [60, 180, 140],
  high: [235, 90, 70],
};

/**
 * 按相对能量分档。
 *
 * @param energy 0~1。
 * @returns 档位。
 */
export function energyTier(energy: number): EnergyTier {
  return energy < 0.34 ? "low" : energy < 0.67 ? "mid" : "high";
}

/** 段落按起点排序。 */
function sortSections(d: ShowProject): void {
  d.sections.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 时刻所在的段落。
 *
 * @param project 工程（只读）。
 * @param atMs 时刻。
 * @returns 段落；不在任何段落里时为 `undefined`。
 */
export function sectionAt(project: Pick<ShowProject, "sections">, atMs: number): Section | undefined {
  return project.sections.find((s) => atMs >= s.startMs && atMs < s.endMs);
}

/**
 * 新建段落：从 `atMs` 开始，到下一个段落开头（或 `lengthMs` 之后、节目结尾）为止。`atMs` 落在已有段落里时不建。
 *
 * @param d 工程草稿。
 * @param atMs 起点。
 * @param lengthMs 默认长度。
 * @param name 名字。
 * @returns 新段落 id；放不下时为 `null`。
 */
export function addSection(d: ShowProject, atMs: number, lengthMs: number, name: string): string | null {
  const start = clamp(Math.round(atMs), 0, d.durationMs);
  if (sectionAt(d, start)) return null;
  const next = d.sections.filter((s) => s.startMs > start).reduce((m, s) => Math.min(m, s.startMs), d.durationMs);
  const end = Math.min(next, start + Math.max(MIN_SECTION_MS, Math.round(lengthMs)), d.durationMs);
  if (end - start < MIN_SECTION_MS) return null;
  const id = newId();
  d.sections.push({ id, name, startMs: start, endMs: end, color: [...TIER_COLORS.mid] });
  sortSections(d);
  return id;
}

/**
 * 修改段落的名字 / 颜色。
 *
 * @param d 工程草稿。
 * @param id 段落 id。
 * @param patch 要改的字段。
 */
export function updateSection(d: ShowProject, id: string, patch: Partial<Pick<Section, "name" | "color">>): void {
  const s = d.sections.find((x) => x.id === id);
  if (s) Object.assign(s, patch);
}

/**
 * 删除段落。
 *
 * @param d 工程草稿。
 * @param id 段落 id。
 */
export function removeSection(d: ShowProject, id: string): void {
  d.sections = d.sections.filter((s) => s.id !== id);
}

/** 换算好的分析结果：可直接写进工程的速度与段落。 */
export interface BeatPlan {
  tempo: Tempo;
  sections: Omit<Section, "id">[];
}

/**
 * 把素材内的分析结果换算到时间线：素材内时刻 `t` 在时间线上是 `片段起点 − 入点 + t`；
 * 段落只保留落在片段范围内的部分。没有片段（素材还没放到时间线上）时按素材从 0 点开始算。
 *
 * @param analysis 后端结果（素材内时刻）。
 * @param clip 素材在时间线上的片段。
 * @param names 各能量档位段落的名字前缀。
 * @returns 速度（第一拍偏移规整到一小节内）与段落。
 */
export function planFromAnalysis(
  analysis: BeatAnalysis,
  clip: Pick<MediaClip, "startMs" | "inMs" | "durationMs"> | null,
  names: Record<EnergyTier, string>,
): BeatPlan {
  const shift = clip ? clip.startMs - clip.inMs : 0;
  const beatsPerBar = Math.max(1, Math.round(analysis.beatsPerBar));
  const barMs = (60_000 / analysis.bpm) * beatsPerBar;
  const offset = Math.round((((analysis.offsetMs + shift) % barMs) + barMs) % barMs);
  const lo = clip ? clip.startMs : 0;
  const hi = clip ? mediaClipEndMs(clip) : analysis.durationMs;
  const counters: Record<EnergyTier, number> = { low: 0, mid: 0, high: 0 };
  const sections: Omit<Section, "id">[] = [];
  for (const g of analysis.sections) {
    const startMs = Math.max(lo, Math.round(g.startMs + shift));
    const endMs = Math.min(hi, Math.round(g.endMs + shift));
    if (endMs - startMs < MIN_SECTION_MS) continue;
    const tier = energyTier(g.energy);
    counters[tier] += 1;
    sections.push({ name: `${names[tier]} ${counters[tier]}`, startMs, endMs, color: [...TIER_COLORS[tier]] });
  }
  return { tempo: { bpm: analysis.bpm, offsetMs: offset, beatsPerBar }, sections };
}

/**
 * 写入分析结果：设置速度；需要时用分析出的段落替换现有段落（超出节目的部分裁掉）。
 *
 * @param d 工程草稿。
 * @param plan 换算好的结果。
 * @param withSections 是否替换段落。
 */
export function applyBeatPlan(d: ShowProject, plan: BeatPlan, withSections: boolean): void {
  setTempo(d, plan.tempo);
  if (!withSections) return;
  d.sections = plan.sections
    .map((s) => ({ ...s, id: newId(), endMs: Math.min(s.endMs, d.durationMs) }))
    .filter((s) => s.endMs - s.startMs >= MIN_SECTION_MS);
  sortSections(d);
}
