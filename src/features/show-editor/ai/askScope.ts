import { eventsIn, type TimelineAnalysis } from "../lib/mediaAnalysis";
import { trackName } from "../lib/ops";
import type { ShowProject } from "../lib/project";
import { formatTimecode } from "../lib/time";
import type { ContextTarget } from "../stores/useEditorUiStore";

/**
 * 时间线上“问 AI”的范围与快捷建议（纯函数）。
 *
 * 范围决定这一轮的上下文：片段沿用选择（摘要里列出选中的片段），段落与时间范围设成时间范围（摘要里写出），
 * 另外在消息末尾附一句人能看懂的范围说明，重新生成时也不丢。快捷建议按对象类型与音乐分析由规则给出，
 * 同样的位置总是同样的建议。
 */

/** 问 AI 的范围。 */
export type AskScope =
  | { kind: "clips"; ids: string[] }
  | { kind: "range"; startMs: number; endMs: number }
  | { kind: "section"; id: string }
  | { kind: "track"; id: string }
  | { kind: "point"; timeMs: number; trackId: string | null };

/** 一条带参数的文案。 */
export interface Phrase {
  key: string;
  args?: Record<string, string | number>;
}

/**
 * 右键目标 → 范围。
 *
 * @param target 右键的目标。
 * @param ui 选择与时间范围。
 * @returns 范围。
 */
export function scopeOf(
  target: ContextTarget,
  ui: { selectedCueIds: readonly string[]; timeRange: { startMs: number; endMs: number } | null; playheadMs: number },
): AskScope {
  switch (target.kind) {
    case "cue":
      return { kind: "clips", ids: ui.selectedCueIds.includes(target.id) ? [...ui.selectedCueIds] : [target.id] };
    case "keyframe":
      return { kind: "clips", ids: [target.cueId] };
    case "range":
      return ui.timeRange ? { kind: "range", ...ui.timeRange } : { kind: "point", timeMs: target.timeMs, trackId: null };
    case "section":
      return { kind: "section", id: target.id };
    case "track":
      return { kind: "track", id: target.id };
    case "empty":
      return { kind: "point", timeMs: target.timeMs, trackId: target.trackId };
    case "ruler":
    case "loop":
      return { kind: "point", timeMs: target.timeMs, trackId: null };
    default:
      return { kind: "point", timeMs: ui.playheadMs, trackId: null };
  }
}

/** 范围的时间区间（片段取并集，轨道 / 位置为 `null`）。 */
export function scopeRange(scope: AskScope, project: ShowProject): { startMs: number; endMs: number } | null {
  if (scope.kind === "range") return { startMs: scope.startMs, endMs: scope.endMs };
  if (scope.kind === "section") {
    const s = project.sections.find((x) => x.id === scope.id);
    return s ? { startMs: s.startMs, endMs: s.endMs } : null;
  }
  if (scope.kind === "clips") {
    const cues = project.cues.filter((c) => scope.ids.includes(c.id));
    return cues.length > 0 ? { startMs: Math.min(...cues.map((c) => c.startMs)), endMs: Math.max(...cues.map((c) => c.endMs)) } : null;
  }
  return null;
}

/**
 * 范围的说明（附在消息末尾）。
 *
 * @param scope 范围。
 * @param project 工程。
 * @returns 文案。
 */
export function scopeNote(scope: AskScope, project: ShowProject): Phrase {
  const span = (a: number, b: number) => `${formatTimecode(a)}–${formatTimecode(b)}`;
  switch (scope.kind) {
    case "clips":
      return { key: "editor.askAi.scope.clips", args: { count: scope.ids.length } };
    case "range":
      return { key: "editor.askAi.scope.range", args: { span: span(scope.startMs, scope.endMs) } };
    case "section": {
      const s = project.sections.find((x) => x.id === scope.id);
      return { key: "editor.askAi.scope.section", args: { name: s?.name ?? "?", span: s ? span(s.startMs, s.endMs) : "" } };
    }
    case "track": {
      const t = project.tracks.find((x) => x.id === scope.id);
      return { key: "editor.askAi.scope.track", args: { name: t ? trackName(project, t) : "?" } };
    }
    case "point": {
      const t = scope.trackId ? project.tracks.find((x) => x.id === scope.trackId) : undefined;
      return t
        ? { key: "editor.askAi.scope.pointTrack", args: { time: formatTimecode(scope.timeMs), name: trackName(project, t) } }
        : { key: "editor.askAi.scope.point", args: { time: formatTimecode(scope.timeMs) } };
    }
  }
}

/**
 * 快捷建议（文案键，最多 4 条）：按范围类型，并在范围里有相应的音乐事件时给出跟音乐有关的建议。
 *
 * @param scope 范围。
 * @param project 工程。
 * @param analysis 音乐分析。
 * @returns 文案。
 */
export function quickPrompts(scope: AskScope, project: ShowProject, analysis: TimelineAnalysis | null): Phrase[] {
  const range = scopeRange(scope, project);
  const has = (kind: "hit" | "drop" | "build" | "cut") => !!analysis && !!range && eventsIn(analysis, [kind], range.startMs, range.endMs).length > 0;
  const p = (key: string): Phrase => ({ key: `editor.askAi.quick.${key}` });
  const out: Phrase[] = [];
  switch (scope.kind) {
    case "clips":
      out.push(p("cooler"), p("faster"));
      if (has("hit")) out.push(p("followBeat"));
      out.push(p("softer"));
      break;
    case "section":
      out.push(analysis ? p("byMusic") : p("fillSection"));
      if (has("drop") || has("hit")) out.push(p("addHits"));
      if (has("cut")) out.push(p("followCuts"));
      if (analysis?.sections.some((s) => s.labelConfidence >= 0.5)) out.push(p("sameAsLabel"));
      break;
    case "range":
      out.push(p("fillRange"));
      if (has("hit")) out.push(p("followBeat"));
      if (has("build")) out.push(p("followBuild"));
      break;
    case "track":
      out.push(p("varyTrack"), p("explainTrack"));
      break;
    case "point":
      out.push(p("fadeInHere"));
      if (analysis) out.push(p("explainMusic"));
      out.push(p("markerHere"));
      break;
  }
  return out.slice(0, 4);
}
