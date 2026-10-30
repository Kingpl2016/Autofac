import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { AiProfile } from "./types";

/**
 * 按 AI 配置创建 AI SDK 的模型实例（本文件引入各家提供商包，只经动态 `import()` 加载）。
 */

/** 交给 SDK 的占位 Key：真实 Key 由后端代理注入，前端拿不到。 */
export const PLACEHOLDER_API_KEY = "injected-by-proxy";

/** 每次调用都带上的生成参数。 */
export interface CallSettings {
  temperature: number;
  seed?: number;
}

/**
 * 创建模型实例。
 *
 * @param profile AI 配置。
 * @param fetch 发请求用的 `fetch`（生产为后端代理，评测脚本为 Node 的 `fetch`）。
 * @param apiKey 交给 SDK 的 Key；经代理时用占位值。
 * @returns 可交给 `generateText` / `streamText` / `ToolLoopAgent` 的模型。
 */
export function createLanguageModel(
  profile: Pick<AiProfile, "kind" | "baseUrl" | "model" | "supportsStructuredOutputs">,
  fetch: typeof globalThis.fetch,
  apiKey: string = PLACEHOLDER_API_KEY,
): LanguageModel {
  switch (profile.kind) {
    case "anthropic":
      return createAnthropic({ baseURL: profile.baseUrl, apiKey, fetch })(profile.model);
    case "google":
      return createGoogleGenerativeAI({ baseURL: profile.baseUrl, apiKey, fetch })(profile.model);
    case "openaiCompatible":
      return createOpenAICompatible({
        name: "openaiCompatible",
        baseURL: profile.baseUrl,
        apiKey,
        fetch,
        includeUsage: true,
        supportsStructuredOutputs: profile.supportsStructuredOutputs,
      })(profile.model);
  }
}

/**
 * 每次调用的生成参数：温度与种子来自配置（默认温度 0，减少不同模型 / 多次调用之间的差异）。
 *
 * @param profile AI 配置。
 * @returns 生成参数。
 */
export function callSettings(profile: Pick<AiProfile, "temperature" | "seed">): CallSettings {
  return profile.seed == null ? { temperature: profile.temperature } : { temperature: profile.temperature, seed: profile.seed };
}
