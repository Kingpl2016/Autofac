import { z } from "zod";

import type { MediaTagsResult, TimelineAnalysis } from "../lib/mediaAnalysis";

/**
 * 多模态标注的纯逻辑（不依赖 AI SDK）：从分析段落挑出要发给模型的片段、模型回答的结构，
 * 以及把回答换成 `MediaTagsResult`。标注只补充曲风 / 情绪 / 人声与段落角色，
 * 时刻始终来自本地分析（模型不写时间）。
 */

/** 段落角色（与草稿里的中文名对应）。 */
export const SECTION_ROLES = ["intro", "verse", "prechorus", "chorus", "bridge", "breakdown", "build", "drop", "solo", "outro"] as const;

/** 最多发几段。 */
export const MAX_TAG_EXCERPTS = 8;
/** 每段多长（毫秒）。 */
export const TAG_EXCERPT_MS = 12_000;
/** 16 kHz 单声道 16 位 WAV 每秒的字节数（估算上传量用）。 */
const WAV_BYTES_PER_SEC = 32_000;
/** 一张关键帧 JPEG 的估算大小（字节）。 */
const FRAME_BYTES = 30_000;
/** 角色的可信度下限：低于它的不用。 */
export const MIN_ROLE_CONFIDENCE = 0.6;

/** 发给模型的一段。 */
export interface TagExcerpt {
  /** 段落序号（从 1 开始，与提示词一致） */
  index: number;
  /** 段落在素材里的起点（角色按它记） */
  sourceStartMs: number;
  /** 截取起点（素材内毫秒） */
  startMs: number;
  lengthMs: number;
  /** 段落能量（提示词里给模型参考） */
  energy: number;
}

/**
 * 要发的片段：每个分析段落取中间的 12 秒（段落太多时均匀取 8 个）。
 *
 * @param analysis 分析（时间线时刻；段落带素材内起点）。
 * @returns 片段（素材内时刻）。
 */
export function excerptPlan(analysis: TimelineAnalysis): TagExcerpt[] {
  const list = analysis.sections;
  const pick = list.length <= MAX_TAG_EXCERPTS ? list.map((_, i) => i) : Array.from({ length: MAX_TAG_EXCERPTS }, (_, k) => Math.round((k * (list.length - 1)) / (MAX_TAG_EXCERPTS - 1)));
  return [...new Set(pick)].map((i) => {
    const s = list[i];
    const len = s.endMs - s.startMs;
    const lengthMs = Math.min(TAG_EXCERPT_MS, len);
    return { index: i + 1, sourceStartMs: s.sourceStartMs, startMs: Math.max(0, Math.round(s.sourceStartMs + (len - lengthMs) / 2)), lengthMs, energy: s.energy };
  });
}

/**
 * 估算上传量（字节）。
 *
 * @param plan 片段。
 * @param audio 是否发音频。
 * @param frames 是否发关键帧。
 * @returns 字节数（Base64 之前）。
 */
export function uploadBytes(plan: readonly TagExcerpt[], audio: boolean, frames: boolean): number {
  const wav = audio ? plan.reduce((sum, p) => sum + (p.lengthMs / 1000) * WAV_BYTES_PER_SEC + 44, 0) : 0;
  return Math.round(wav + (frames ? plan.length * FRAME_BYTES : 0));
}

/** 模型回答的结构。 */
export const tagAnswerSchema = z.object({
  genre: z.string().max(40).describe("Music genre in a few words, e.g. 'synth pop'"),
  mood: z.string().max(40).describe("Overall mood in a few words, e.g. 'uplifting'"),
  vocals: z.boolean().describe("Whether the song has vocals"),
  sections: z
    .array(
      z.object({
        index: z.number().int().min(1).max(64).describe("Section number from the list"),
        role: z.enum(SECTION_ROLES),
        confidence: z.number().min(0).max(1).describe("How sure you are, 0..1"),
      }),
    )
    .max(64),
});

/** 模型的回答。 */
export type TagAnswer = z.output<typeof tagAnswerSchema>;

/**
 * 提示词（英文）。
 *
 * @param plan 片段。
 * @param audio 是否附了音频。
 * @param frames 是否附了关键帧。
 * @returns 文字。
 */
export function tagPrompt(plan: readonly TagExcerpt[], audio: boolean, frames: boolean): string {
  const what = [audio ? "an audio excerpt" : null, frames ? "a video keyframe" : null].filter(Boolean).join(" and ");
  return [
    `You are tagging a song for a lighting designer. For each numbered section below you get ${what} from its middle, in order.`,
    "Tell the genre, the mood, whether there are vocals, and the role of each section. Use a low confidence when unsure; do not guess.",
    "Sections:",
    ...plan.map((p) => `${p.index}. starts at ${(p.sourceStartMs / 1000).toFixed(1)}s, relative energy ${p.energy.toFixed(2)}`),
  ].join("\n");
}

/**
 * 把回答换成标注结果：角色只保留可信的、属于发出去的段落的。
 *
 * @param answer 回答。
 * @param plan 片段。
 * @returns 标注结果。
 */
export function tagsFromAnswer(answer: TagAnswer, plan: readonly TagExcerpt[]): MediaTagsResult {
  const byIndex = new Map(plan.map((p) => [p.index, p]));
  const roles: Record<string, string> = {};
  for (const s of answer.sections) {
    const p = byIndex.get(s.index);
    if (p && s.confidence >= MIN_ROLE_CONFIDENCE) roles[String(p.sourceStartMs)] = s.role;
  }
  const clean = (v: string) => v.trim().slice(0, 40) || undefined;
  return { genre: clean(answer.genre), mood: clean(answer.mood), vocals: answer.vocals, roles };
}
