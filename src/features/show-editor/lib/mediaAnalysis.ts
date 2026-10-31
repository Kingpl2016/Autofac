import { mediaClipEndMs } from "./mediaClips";
import { MIN_LABEL_CONFIDENCE, type AudioAnalysis, type BarFeature, type MusicEventKind } from "./mediaApi";
import type { MediaClip, MediaRef, ShowProject } from "./project";

/**
 * 音乐结构分析结果换算到时间线：后端给的是素材内时刻，素材放在时间线上的位置是
 * “片段起点 − 入点”，只保留落在片段范围里的部分。时间线参考线、主动建议、给模型看的特征表
 * 与编译器放置重音都用这份换算后的结果（纯函数，不依赖 AI）。
 */

/** 一个事件（时间线时刻）。 */
export interface TimelineEvent {
  kind: MusicEventKind | "cut";
  atMs: number;
  /** 渐强的终点 */
  endMs?: number;
  /** 强度 0~1 */
  strength: number;
}

/** 一个分析段落（时间线时刻）。 */
export interface TimelineSection {
  startMs: number;
  endMs: number;
  energy: number;
  brightness: number;
  bass: number;
  density: number;
  /** 结构标签（用户改过的以用户的为准） */
  label: string;
  /** 标签置信度 0~1（用户改过的为 1） */
  labelConfidence: number;
  /** 用户改过标签 */
  edited: boolean;
  /** 段落角色（多模态标注，可信时才有） */
  role?: string;
  /** 在素材里的起点（标签覆盖、角色标注按它对应） */
  sourceStartMs: number;
}

/** 一个镜头（视频分析，时间线时刻）。 */
export interface TimelineShot {
  startMs: number;
  endMs: number;
  /** 主色 sRGB */
  rgb: [number, number, number];
  /** 平均亮度 0~1 */
  brightness: number;
}

/** 换算到时间线的分析结果。 */
export interface TimelineAnalysis {
  mediaId: string;
  mediaName: string;
  bpm: number;
  confidence: number;
  /** 时间线上第一拍（强拍）的偏移（规整到一小节内） */
  offsetMs: number;
  beatsPerBar: number;
  /** 逐拍时刻（时间线） */
  beatsMs: number[];
  bars: (BarFeature & { startMs: number; endMs: number })[];
  sections: TimelineSection[];
  events: TimelineEvent[];
  /** 视频镜头（有视频分析时） */
  shots: TimelineShot[];
  /** 多模态标签（曲风、情绪、人声；有标注时） */
  tags?: { genre?: string; mood?: string; vocals?: boolean };
}

/** 用户对一个素材的分析设置（跟着工程的对话记录保存）。 */
export interface MediaAnalysisPrefs {
  /** 灵敏度 */
  sensitivity: number;
  /** 改过的段落标签：素材内起点（毫秒，字符串）→ 标签 */
  labels: Record<string, string>;
}

/** 视频分析结果（素材内时刻，见 `videoAnalysis.ts`）。 */
export interface VideoAnalysisResult {
  cuts: { atMs: number; strength: number }[];
  shots: { startMs: number; endMs: number; rgb: [number, number, number]; brightness: number }[];
}

/** 多模态标签（素材内时刻，见 AI 的 `mediaTags`）。 */
export interface MediaTagsResult {
  genre?: string;
  mood?: string;
  vocals?: boolean;
  /** 段落角色：素材内起点（毫秒，字符串）→ 角色 */
  roles: Record<string, string>;
}

/** 换算的输入：素材、片段与各部分结果。 */
export interface AnalysisSources {
  media: Pick<MediaRef, "id" | "name">;
  clip: Pick<MediaClip, "startMs" | "inMs" | "durationMs"> | null;
  audio: AudioAnalysis | null;
  video?: VideoAnalysisResult | null;
  tags?: MediaTagsResult | null;
  prefs?: MediaAnalysisPrefs | null;
}

/**
 * 换算到时间线。
 *
 * @param src 素材、片段（没放上时间线时为 `null`，按 0 点算）与分析结果。
 * @returns 换算后的结果；没有音频分析时也给出（只有镜头），音频与视频都没有时为 `null`。
 */
export function mapAnalysis(src: AnalysisSources): TimelineAnalysis | null {
  const { audio, clip } = src;
  if (!audio && !src.video) return null;
  const shift = clip ? clip.startMs - clip.inMs : 0;
  const lo = clip ? clip.startMs : 0;
  const hi = clip ? mediaClipEndMs(clip) : Number.POSITIVE_INFINITY;
  const at = (ms: number) => Math.round(ms + shift);
  const inside = (a: number, b: number) => b > lo && a < hi;
  const clampRange = (a: number, b: number) => ({ startMs: Math.max(lo, at(a)), endMs: Math.min(hi, at(b)) });

  const beatsPerBar = audio ? Math.max(1, Math.round(audio.beats.beatsPerBar)) : 4;
  const barMs = audio ? (60_000 / audio.beats.bpm) * beatsPerBar : 0;
  const labels = src.prefs?.labels ?? {};
  const roles = src.tags?.roles ?? {};
  const sections: TimelineSection[] = (audio?.sections ?? [])
    .filter((s) => inside(at(s.startMs), at(s.endMs)))
    .map((s) => {
      const key = String(s.startMs);
      const edited = key in labels;
      const confident = edited || s.labelConfidence >= MIN_LABEL_CONFIDENCE;
      return {
        ...clampRange(s.startMs, s.endMs),
        energy: s.energy,
        brightness: s.brightness,
        bass: s.bass,
        density: s.density,
        label: edited ? labels[key] : s.label,
        labelConfidence: edited ? 1 : s.labelConfidence,
        edited,
        // 标签不可信时不给角色（避免把不准的结构当成主歌 / 副歌）
        ...(confident && roles[key] ? { role: roles[key] } : {}),
        sourceStartMs: s.startMs,
      };
    });
  const events: TimelineEvent[] = [
    ...(audio?.events ?? [])
      .filter((e) => at(e.atMs) >= lo && at(e.atMs) < hi)
      .map((e) => ({
        kind: e.kind,
        atMs: at(e.atMs),
        ...(e.endMs === undefined ? {} : { endMs: Math.min(hi, at(e.endMs)) }),
        strength: e.strength,
      })),
    ...(src.video?.cuts ?? []).filter((c) => at(c.atMs) >= lo && at(c.atMs) < hi).map((c) => ({ kind: "cut" as const, atMs: at(c.atMs), strength: c.strength })),
  ].sort((a, b) => a.atMs - b.atMs || a.kind.localeCompare(b.kind));
  return {
    mediaId: src.media.id,
    mediaName: src.media.name,
    bpm: audio?.beats.bpm ?? 0,
    confidence: audio?.beats.confidence ?? 0,
    offsetMs: audio && barMs > 0 ? Math.round((((audio.beats.offsetMs + shift) % barMs) + barMs) % barMs) : 0,
    beatsPerBar,
    beatsMs: (audio?.beats.beatsMs ?? []).map(at).filter((t) => t >= lo && t < hi),
    bars: (audio?.bars ?? []).filter((b) => inside(at(b.startMs), at(b.endMs))).map((b) => ({ ...b, ...clampRange(b.startMs, b.endMs) })),
    sections,
    events,
    shots: (src.video?.shots ?? []).filter((s) => inside(at(s.startMs), at(s.endMs))).map((s) => ({ ...s, ...clampRange(s.startMs, s.endMs) })),
    ...(src.tags ? { tags: { genre: src.tags.genre, mood: src.tags.mood, vocals: src.tags.vocals } } : {}),
  };
}

/**
 * 主素材在时间线上最早的片段（没放上时间线时为 `null`）。
 *
 * @param project 工程。
 * @param mediaId 素材 id。
 * @returns 片段或 `null`。
 */
export function firstClipOf(project: Pick<ShowProject, "mediaClips">, mediaId: string): MediaClip | null {
  return [...project.mediaClips].filter((c) => c.mediaId === mediaId).sort((a, b) => a.startMs - b.startMs)[0] ?? null;
}

/**
 * 时间范围内的分析：与范围重叠的小节按重叠时长加权平均，标签取重叠最多的分析段落。
 *
 * @param analysis 分析结果。
 * @param startMs 起点（时间线）。
 * @param endMs 终点（时间线）。
 * @returns 平均特征与标签；范围里没有小节时为 `null`。
 */
export function featuresIn(
  analysis: TimelineAnalysis,
  startMs: number,
  endMs: number,
): { energy: number; brightness: number; bass: number; density: number; label: string | null; confident: boolean; role?: string } | null {
  let total = 0;
  const sum = { energy: 0, brightness: 0, bass: 0, density: 0 };
  for (const b of analysis.bars) {
    const w = Math.min(b.endMs, endMs) - Math.max(b.startMs, startMs);
    if (w <= 0) continue;
    total += w;
    sum.energy += b.energy * w;
    sum.brightness += b.brightness * w;
    sum.bass += b.bass * w;
    sum.density += b.density * w;
  }
  if (total <= 0) return null;
  let best: TimelineSection | null = null;
  let bestOverlap = 0;
  for (const s of analysis.sections) {
    const w = Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs);
    if (w > bestOverlap) {
      best = s;
      bestOverlap = w;
    }
  }
  return {
    energy: sum.energy / total,
    brightness: sum.brightness / total,
    bass: sum.bass / total,
    density: sum.density / total,
    label: best?.label ?? null,
    confident: !!best && (best.edited || best.labelConfidence >= MIN_LABEL_CONFIDENCE),
    ...(best?.role ? { role: best.role } : {}),
  };
}

/**
 * 范围内的事件。
 *
 * @param analysis 分析结果。
 * @param kinds 只要这几类（空为全部）。
 * @param startMs 起点。
 * @param endMs 终点。
 * @returns 事件（按时刻）。
 */
export function eventsIn(analysis: TimelineAnalysis, kinds: readonly TimelineEvent["kind"][], startMs: number, endMs: number): TimelineEvent[] {
  return analysis.events.filter((e) => (kinds.length === 0 || kinds.includes(e.kind)) && e.atMs >= startMs && e.atMs < endMs);
}
