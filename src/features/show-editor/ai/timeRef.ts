import { clamp } from "@/shared/lib/math";
import type { ShowProject } from "../lib/project";
import { snapToFrame } from "../lib/time";
import { resolveAlias, type AliasMap } from "./aliases";

/**
 * AI 中间语言里的时间：模型不写毫秒，写“第几小节”“哪个段落”“几秒”。
 *
 * - `12.5s`：秒；
 * - `b17`、`b17:3`、`b17:2.5`：第 17 小节（第 3 拍），小节与拍都从 1 起，需要工程有节拍；
 * - `S2`、`S2:end`：段落的起点 / 终点；
 * - `M1`：标记点；
 * - `start`、`end`：节目起点 / 终点；`playhead`：播放头。
 *
 * 偏移量（移动片段）：`+2bars`、`-1beats`、`+0.5s`。
 *
 * 写成秒或拍的时间会量化：有节拍时对齐到 1/4 拍，没有节拍时对齐到 0.1 秒，再对齐到输出帧。
 * 段落、标记点、播放头取原值（只对齐到帧）。
 */

/** 时间引用的格式（schema 的 `description` 里给模型看）。 */
export const TIME_REF_HELP = "Time: '12.5s' | 'b17' (bar 17) | 'b17:3' (bar 17 beat 3) | 'S2' / 'S2:end' (section) | 'M1' (marker) | 'start' | 'end' | 'playhead'";

/** 偏移量的格式。 */
export const SHIFT_HELP = "Offset: '+2bars' | '-1beats' | '+0.5s'";

/** 解析时间需要的上下文。 */
export interface TimeContext {
  project: Pick<ShowProject, "tempo" | "sections" | "markers" | "durationMs">;
  aliases: AliasMap;
  playheadMs: number;
}

/** 解析结果：毫秒，或给模型看的错误说明。 */
export type TimeResult = { ok: true; ms: number } | { ok: false; error: string };

/** 每拍毫秒数。 */
function beatMs(project: TimeContext["project"]): number | null {
  return project.tempo && project.tempo.bpm > 0 ? 60_000 / project.tempo.bpm : null;
}

/**
 * 量化按秒 / 拍给出的时间：有节拍时对齐到 1/4 拍，否则对齐到 0.1 秒；再对齐到帧。
 *
 * @param ms 时间（毫秒）。
 * @param project 工程（节拍）。
 * @returns 量化后的毫秒。
 */
export function quantizeMs(ms: number, project: TimeContext["project"]): number {
  const beat = beatMs(project);
  if (beat && project.tempo) {
    const grid = beat / 4;
    const offset = project.tempo.offsetMs;
    return snapToFrame(offset + Math.round((ms - offset) / grid) * grid);
  }
  return snapToFrame(Math.round(ms / 100) * 100);
}

/**
 * 解析时间引用。
 *
 * @param ref 时间引用（见文件说明）。
 * @param ctx 上下文。
 * @returns 毫秒（夹在 `[0, 24h]`，不受节目时长限制，放片段时再延长节目）；或错误说明。
 */
export function resolveTime(ref: string, ctx: TimeContext): TimeResult {
  const s = ref.trim();
  const { project } = ctx;
  const out = (ms: number): TimeResult => ({ ok: true, ms: clamp(ms, 0, 24 * 3600 * 1000) });
  if (s === "start") return out(0);
  if (s === "end") return out(project.durationMs);
  if (s === "playhead") return out(snapToFrame(ctx.playheadMs));

  const sec = /^(\d+(?:\.\d+)?)s$/i.exec(s);
  if (sec) return out(quantizeMs(Number(sec[1]) * 1000, project));

  const bar = /^b(\d+)(?::(\d+(?:\.\d+)?))?$/i.exec(s);
  if (bar) {
    const beat = beatMs(project);
    if (!beat || !project.tempo) return { ok: false, error: `'${s}': the show has no tempo; use seconds like '12.5s'` };
    const barNo = Number(bar[1]);
    const beatNo = bar[2] === undefined ? 1 : Number(bar[2]);
    if (barNo < 1 || beatNo < 1 || beatNo >= project.tempo.beatsPerBar + 1) {
      return { ok: false, error: `'${s}': bar and beat start at 1; a bar has ${project.tempo.beatsPerBar} beats` };
    }
    const beats = (barNo - 1) * project.tempo.beatsPerBar + (beatNo - 1);
    return out(quantizeMs(project.tempo.offsetMs + beats * beat, project));
  }

  const section = /^S(\d+)(?::(start|end))?$/i.exec(s);
  if (section) {
    const id = resolveAlias(ctx.aliases, `S${section[1]}`, "S");
    const found = id ? project.sections.find((x) => x.id === id) : undefined;
    if (!found) return { ok: false, error: `'${s}': no such section` };
    return out(snapToFrame(section[2]?.toLowerCase() === "end" ? found.endMs : found.startMs));
  }

  const marker = /^M(\d+)$/i.exec(s);
  if (marker) {
    const id = resolveAlias(ctx.aliases, `M${marker[1]}`, "M");
    const found = id ? project.markers.find((x) => x.id === id) : undefined;
    if (!found) return { ok: false, error: `'${s}': no such marker` };
    return out(found.timeMs);
  }
  return { ok: false, error: `'${s}' is not a valid time. ${TIME_REF_HELP}` };
}

/**
 * 解析偏移量。
 *
 * @param ref 偏移量（`+2bars` / `-1beats` / `+0.5s`）。
 * @param project 工程（节拍）。
 * @returns 毫秒（可为负）；或错误说明。
 */
export function resolveShift(ref: string, project: TimeContext["project"]): TimeResult {
  const m = /^([+-])(\d+(?:\.\d+)?)(s|beats?|bars?)$/i.exec(ref.trim());
  if (!m) return { ok: false, error: `'${ref}' is not a valid offset. ${SHIFT_HELP}` };
  const sign = m[1] === "-" ? -1 : 1;
  const n = Number(m[2]);
  const unit = m[3].toLowerCase();
  if (unit === "s") return { ok: true, ms: sign * Math.round((n * 1000) / 100) * 100 };
  const beat = beatMs(project);
  if (!beat || !project.tempo) return { ok: false, error: `'${ref}': the show has no tempo; use seconds like '+2s'` };
  const beats = unit.startsWith("bar") ? n * project.tempo.beatsPerBar : n;
  // 偏移量对齐到 1/4 拍
  return { ok: true, ms: sign * Math.round(Math.round(beats * 4) * (beat / 4)) };
}

/**
 * 时间的可读写法（上下文摘要用）：`m:ss.s`，有节拍时附小节号。
 *
 * @param ms 时间。
 * @param project 工程（节拍）。
 * @returns 例如 `1:02.5 (b33)`。
 */
export function describeTime(ms: number, project: TimeContext["project"]): string {
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(1).padStart(4, "0");
  const beat = beatMs(project);
  if (!beat || !project.tempo) return `${m}:${s}`;
  const beats = (ms - project.tempo.offsetMs) / beat;
  if (beats < 0) return `${m}:${s}`;
  const barNo = Math.floor(beats / project.tempo.beatsPerBar) + 1;
  const beatNo = Math.round((beats - (barNo - 1) * project.tempo.beatsPerBar + 1) * 4) / 4;
  return beatNo === 1 ? `${m}:${s} (b${barNo})` : `${m}:${s} (b${barNo}:${beatNo})`;
}
