import type { LanguageModel } from "ai";

import { createProxyFetch } from "./proxyFetch";
import type { CallSettings } from "./model";
import type { AiProfileView } from "./types";

/** 已就绪的模型：实例、所属配置与生成参数。 */
export interface LoadedModel {
  model: LanguageModel;
  profile: AiProfileView;
  settings: CallSettings;
}

/**
 * 加载某个 AI 配置的模型（经后端代理）。AI SDK 与各家提供商包在这里才按需加载，不进首屏包。
 *
 * @param profile AI 配置。
 * @returns 模型实例与生成参数。
 */
export async function loadLanguageModel(profile: AiProfileView): Promise<LoadedModel> {
  const { createLanguageModel, callSettings } = await import("./model");
  return {
    model: createLanguageModel(profile, createProxyFetch(profile.id)),
    profile,
    settings: callSettings(profile),
  };
}

/** 测试连接的结果。 */
export interface ConnectionResult {
  /** 模型的回复（截断）。 */
  reply: string;
  /** 往返耗时（毫秒）。 */
  ms: number;
}

/**
 * 测试连接：让模型回复一个很短的句子。
 *
 * @param profile AI 配置。
 * @param signal 中止信号。
 * @returns 回复与耗时；失败时抛出（用 `aiErrorText` 转成文案）。
 */
export async function testConnection(profile: AiProfileView, signal?: AbortSignal): Promise<ConnectionResult> {
  const [{ generateText }, loaded] = await Promise.all([import("ai"), loadLanguageModel(profile)]);
  const started = performance.now();
  const { text } = await generateText({
    model: loaded.model,
    ...loaded.settings,
    maxOutputTokens: 32,
    abortSignal: signal,
    prompt: "Reply with exactly: OK",
  });
  return { reply: text.trim().slice(0, 80), ms: Math.round(performance.now() - started) };
}
