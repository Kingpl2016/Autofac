import { generateText, Output, type FilePart, type ImagePart, type TextPart } from "ai";

import type { LoadedModel } from "@/features/ai";
import type { MediaTagsResult, TimelineAnalysis } from "../lib/mediaAnalysis";
import { excerptPlan, tagAnswerSchema, tagPrompt, tagsFromAnswer, type TagExcerpt } from "./mediaTagsPlan";

/**
 * 多模态标注（按需加载，引入 AI SDK）：把每个段落中间的一小段音频 / 一张关键帧发给支持的模型，
 * 用结构化输出得到曲风、情绪、人声与段落角色。调用方负责事先征得用户同意。
 */

/** 标注的输入。 */
export interface TagRequest {
  loaded: LoadedModel;
  analysis: TimelineAnalysis;
  /** 截取音频（Base64 WAV，与片段一一对应；空串为没有音频）；省略时不发音频 */
  excerpts?: (plan: readonly TagExcerpt[]) => Promise<string[]>;
  /** 截取关键帧（Base64 JPEG，与片段一一对应；空串为没有画面）；省略时不发画面 */
  frames?: (plan: readonly TagExcerpt[]) => Promise<string[]>;
  signal?: AbortSignal;
}

/**
 * 标注一个素材。
 *
 * @param req 模型、分析与取素材的函数。
 * @returns 标注结果；没有段落时为 `null`。
 * @throws 模型调用失败、回答不合结构或被取消。
 */
export async function tagMedia(req: TagRequest): Promise<MediaTagsResult | null> {
  const plan = excerptPlan(req.analysis);
  if (plan.length === 0) return null;
  const [audio, frames] = await Promise.all([req.excerpts?.(plan) ?? Promise.resolve([]), req.frames?.(plan) ?? Promise.resolve([])]);
  const hasAudio = audio.some(Boolean);
  const hasFrames = frames.some(Boolean);
  if (!hasAudio && !hasFrames) return null;
  const content: (TextPart | FilePart | ImagePart)[] = [{ type: "text", text: tagPrompt(plan, hasAudio, hasFrames) }];
  plan.forEach((p, i) => {
    content.push({ type: "text", text: `Section ${p.index}:` });
    if (audio[i]) content.push({ type: "file", mediaType: "audio/wav", data: audio[i] });
    if (frames[i]) content.push({ type: "image", mediaType: "image/jpeg", image: frames[i] });
  });
  const result = await generateText({
    model: req.loaded.model,
    ...req.loaded.settings,
    messages: [{ role: "user", content }],
    output: Output.object({ schema: tagAnswerSchema }),
    abortSignal: req.signal,
    maxRetries: 1,
  });
  return tagsFromAnswer(result.output, plan);
}
