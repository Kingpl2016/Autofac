import { eventsIn, featuresIn, type TimelineAnalysis, type TimelineEvent } from "../lib/mediaAnalysis";
import type { ShowProject } from "../lib/project";
import { energyTier } from "../lib/sections";
import { aliasOf, type AliasMap } from "./aliases";
import { describeTime } from "./timeRef";

/**
 * 给模型看的音乐分析：每段一行固定格式的特征（能量档位与 0~9 的数值、亮度、低频、密度、结构标签），
 * 加上事件的数量与位置。同一份分析总是写出同样的文字，各模型看到的内容完全相同。
 * 时刻精确的事件（冲击、爆点）由编译器的 `placeAccents` 放置，模型不需要写毫秒。
 */

/** 每类事件最多直接列出几个位置。 */
const MAX_LISTED = 12;

/** 0~1 → 0~9。 */
const digit = (v: number) => Math.max(0, Math.min(9, Math.round(v * 9)));

/** 一行特征。 */
function featureLine(f: NonNullable<ReturnType<typeof featuresIn>>): string {
  const label = f.label ? ` label ${f.label}${f.confident ? "" : "?"}` : "";
  const role = f.role ? ` role ${f.role}` : "";
  return `energy ${energyTier(f.energy)}(${digit(f.energy)}) bright ${digit(f.brightness)} bass ${digit(f.bass)} density ${digit(f.density)}${label}${role}`;
}

/** 事件的位置文字。 */
function eventsLine(kind: TimelineEvent["kind"], events: readonly TimelineEvent[], project: ShowProject): string | null {
  const list = events.filter((e) => e.kind === kind);
  if (list.length === 0) return null;
  const where = list.slice(0, MAX_LISTED).map((e) => (e.endMs === undefined ? describeTime(e.atMs, project) : `${describeTime(e.atMs, project)}→${describeTime(e.endMs, project)}`));
  const more = list.length > MAX_LISTED ? `, … ${list.length - MAX_LISTED} more` : "";
  const name = { hit: "hits", build: "builds", drop: "drops", break: "breaks", cut: "video cuts" }[kind];
  return `  ${name} (${list.length}): ${where.join(", ")}${more}`;
}

/**
 * 工程摘要里的“Music”一节。
 *
 * @param project 工程。
 * @param aliases 别名表。
 * @param analysis 换算到时间线的分析；没有时返回空数组。
 * @returns 多行文字。
 */
export function musicLines(project: ShowProject, aliases: AliasMap, analysis: TimelineAnalysis | null): string[] {
  if (!analysis) {
    // 有音视频但还没分析（导入时不自动分析）：告诉模型需要时用工具分析
    return project.mediaClips.length > 0 ? ["Music: the song on the timeline is not analysed yet; call analyze_media or list_media_events if you need its beats, sections or accents (it analyses the song first)."] : [];
  }
  const out: string[] = [];
  const head = analysis.bpm > 0 ? `${analysis.bpm} BPM, beat confidence ${Math.round(analysis.confidence * 100)}%` : "no beat analysis";
  const tags = analysis.tags
    ? [analysis.tags.genre && `genre ${analysis.tags.genre}`, analysis.tags.mood && `mood ${analysis.tags.mood}`, analysis.tags.vocals !== undefined && (analysis.tags.vocals ? "vocals" : "instrumental")]
        .filter(Boolean)
        .join(", ")
    : "";
  out.push(`Music analysis of the main media (${head}${tags ? `; ${tags}` : ""}). Levels are 0-9 relative to this song; a label like 'A' marks sections that sound alike ('?' = unsure):`);
  const sections = [...project.sections].sort((a, b) => a.startMs - b.startMs);
  if (sections.length > 0) {
    for (const s of sections) {
      const f = featuresIn(analysis, s.startMs, s.endMs);
      out.push(`  ${aliasOf(aliases, s.id)} ${f ? featureLine(f) : "(outside the media)"}`);
    }
  } else if (analysis.sections.length > 0) {
    out.push("  (the show has no sections; analysed parts:)");
    for (const s of analysis.sections) {
      const f = featuresIn(analysis, s.startMs, s.endMs);
      if (f) out.push(`  ${describeTime(s.startMs, project)} → ${describeTime(s.endMs, project)} ${featureLine(f)}`);
    }
  }
  const events = analysis.events;
  if (events.length > 0) {
    out.push("Events (use placeAccents to put clips exactly on them):");
    for (const kind of ["hit", "build", "drop", "break", "cut"] as const) {
      const line = eventsLine(kind, events, project);
      if (line) out.push(line);
    }
  }
  if (analysis.shots.length > 0) out.push(`Video: ${analysis.shots.length} shots with their own main colors (placeAccents cuts with colors 'fromVideo').`);
  return out;
}

/**
 * `list_media_events` 工具的结果：范围内某类（或全部）事件的逐条列表。
 *
 * @param project 工程。
 * @param analysis 分析；没有时说明原因。
 * @param kind 事件类型；`null` 为全部。
 * @param range 时间范围（毫秒，时间线）。
 * @returns 多行文字（最多 100 条）。
 */
export function eventsList(project: ShowProject, analysis: TimelineAnalysis | null, kind: TimelineEvent["kind"] | null, range: { startMs: number; endMs: number }): string {
  if (!analysis) return "No music analysis is available (the show has no media, or it could not be analysed).";
  const list = eventsIn(analysis, kind ? [kind] : [], range.startMs, range.endMs);
  if (list.length === 0) return `No ${kind ?? "events"} between ${describeTime(range.startMs, project)} and ${describeTime(range.endMs, project)}.`;
  const lines = list.slice(0, 100).map((e) => `  ${e.kind} ${describeTime(e.atMs, project)}${e.endMs === undefined ? "" : ` → ${describeTime(e.endMs, project)}`} strength ${digit(e.strength)}`);
  if (list.length > 100) lines.push(`  … ${list.length - 100} more`);
  return [`${list.length} event(s):`, ...lines].join("\n");
}

/**
 * `analyze_media` 工具的结果：一个范围内逐小节的特征与事件。
 *
 * @param project 工程。
 * @param analysis 分析；没有时说明原因。
 * @param range 时间范围（毫秒，时间线）。
 * @returns 多行文字。
 */
export function analysisDetail(project: ShowProject, analysis: TimelineAnalysis | null, range: { startMs: number; endMs: number }): string {
  if (!analysis) return "No music analysis is available (the show has no media, or it could not be analysed).";
  const bars = analysis.bars.filter((b) => b.endMs > range.startMs && b.startMs < range.endMs);
  const lines = [`Bars ${describeTime(range.startMs, project)} → ${describeTime(range.endMs, project)} (energy/bright/bass/density 0-9, loudness dB):`];
  for (const b of bars.slice(0, 64)) {
    lines.push(`  ${describeTime(b.startMs, project)} e${digit(b.energy)} b${digit(b.brightness)} l${digit(b.bass)} d${digit(b.density)} ${b.loudnessDb.toFixed(0)}dB`);
  }
  if (bars.length > 64) lines.push(`  … ${bars.length - 64} more bars; ask for a shorter range`);
  if (bars.length === 0) lines.push("  (no bars in this range)");
  const events = eventsIn(analysis, [], range.startMs, range.endMs);
  if (events.length > 0) {
    lines.push("Events:");
    for (const kind of ["hit", "build", "drop", "break", "cut"] as const) {
      const line = eventsLine(kind, events, project);
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}
