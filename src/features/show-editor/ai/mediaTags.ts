import { generateText, Output, type FilePart, type TextPart } from "ai";

import { unsupportedInput, type LoadedModel } from "@/features/ai";
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

/** 标注的结果。 */
export interface TagOutcome {
  tags: MediaTagsResult;
  /** 模型不接受、因而没有发送的输入（配置勾选了但模型其实不支持） */
  dropped: ("audio" | "image")[];
}

/** 发一次请求。 */
async function ask(req: TagRequest, plan: readonly TagExcerpt[], audio: readonly string[], frames: readonly string[]): Promise<MediaTagsResult> {
  const hasAudio = audio.some(Boolean);
  const hasFrames = frames.some(Boolean);
  const content: (TextPart | FilePart)[] = [{ type: "text", text: tagPrompt(plan, hasAudio, hasFrames) }];
  plan.forEach((p, i) => {
    content.push({ type: "text", text: `Section ${p.index}:` });
    if (audio[i]) content.push({ type: "file", mediaType: "audio/wav", data: audio[i] });
    if (frames[i]) content.push({ type: "file", mediaType: "image/jpeg", data: frames[i] });
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

/**
 * 标注一个素材。模型拒绝音频（或图片）输入时，只要还有另一种输入，就去掉被拒绝的那种再试一次。
 *
 * @param req 模型、分析与取素材的函数。
 * @returns 标注结果与没能发送的输入；没有段落或没有可发送的素材时为 `null`。
 * @throws 模型调用失败、回答不合结构或被取消（两种输入都被拒绝时抛出最后一次的错误）。
 */
export async function tagMedia(req: TagRequest): Promise<TagOutcome | null> {
  const plan = excerptPlan(req.analysis);
  if (plan.length === 0) return null;
  let [audio, frames] = await Promise.all([req.excerpts?.(plan) ?? Promise.resolve([]), req.frames?.(plan) ?? Promise.resolve([])]);
  const dropped: TagOutcome["dropped"] = [];
  for (;;) {
    if (!audio.some(Boolean) && !frames.some(Boolean)) return null;
    try {
      return { tags: await ask(req, plan, audio, frames), dropped };
    } catch (e) {
      const rejected = unsupportedInput(e);
      const other = rejected === "audio" ? frames : audio;
      if (!rejected || dropped.includes(rejected) || !other.some(Boolean)) throw e;
      dropped.push(rejected);
      if (rejected === "audio") audio = [];
      else frames = [];
    }
  }
}
