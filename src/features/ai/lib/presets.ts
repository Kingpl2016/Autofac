import type { AiModality, AiProfileInput, AiProviderKind } from "./types";

/**
 * 常用模型服务的接口预设：新建配置时一键填好协议、接口地址与常用模型。
 *
 * 模型 id 只是建议（各家更新很快），用户可以改成任何该服务支持的模型。
 * `structured` 表示该服务的 OpenAI 兼容接口支持 `response_format: json_schema`；
 * 不支持时 SDK 退回 JSON 模式，结构由我们自己的 zod 校验兜底。
 */
export interface ProviderPreset {
  /** 预设 id（也是名称的文案键后缀）。 */
  id: string;
  kind: AiProviderKind;
  baseUrl: string;
  /** 建议的模型 id（第一个为默认）。 */
  models: readonly string[];
  structured: boolean;
  /** 是否需要 API Key（本地服务通常不需要）。 */
  needsKey: boolean;
  /** 默认模型除文字外还接受的输入（用户可以改）。 */
  modalities?: readonly AiModality[];
}

/** 内置预设（按常用程度排列）。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "deepseek", kind: "openaiCompatible", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], structured: false, needsKey: true },
  { id: "qwen", kind: "openaiCompatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-plus", "qwen-max", "qwen-turbo"], structured: true, needsKey: true },
  { id: "glm", kind: "openaiCompatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-plus", "glm-4-flash"], structured: false, needsKey: true },
  { id: "kimi", kind: "openaiCompatible", baseUrl: "https://api.moonshot.cn/v1", models: ["kimi-latest", "moonshot-v1-32k"], structured: false, needsKey: true },
  { id: "openai", kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1", models: ["gpt-4.1", "gpt-4.1-mini"], structured: true, needsKey: true, modalities: ["image"] },
  { id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-5", "claude-haiku-4-5"], structured: true, needsKey: true, modalities: ["image"] },
  { id: "gemini", kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-2.5-flash", "gemini-2.5-pro"], structured: true, needsKey: true, modalities: ["image", "audio"] },
  { id: "ollama", kind: "openaiCompatible", baseUrl: "http://localhost:11434/v1", models: ["qwen2.5:14b", "llama3.1:8b"], structured: true, needsKey: false },
  { id: "lmstudio", kind: "openaiCompatible", baseUrl: "http://localhost:1234/v1", models: ["local-model"], structured: true, needsKey: false },
];

/**
 * 按接口地址找对应的预设（编辑已有配置时用来给出建议的模型）；没有完全匹配时按主机匹配。
 *
 * @param baseUrl 接口地址。
 * @returns 预设；都对不上时为 `undefined`。
 */
export function presetForUrl(baseUrl: string): ProviderPreset | undefined {
  const norm = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const exact = PROVIDER_PRESETS.find((p) => p.baseUrl.toLowerCase() === norm);
  if (exact) return exact;
  try {
    const host = new URL(norm).host;
    return PROVIDER_PRESETS.find((p) => new URL(p.baseUrl).host === host);
  } catch {
    return undefined;
  }
}

/**
 * 由预设得到新建配置的初始输入。
 *
 * @param preset 预设。
 * @returns 配置输入（温度 0，保证不同模型结果接近）。
 */
export function inputFromPreset(preset: ProviderPreset): AiProfileInput {
  return {
    id: null,
    name: "",
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.models[0] ?? "",
    supportsStructuredOutputs: preset.structured,
    inputModalities: [...(preset.modalities ?? [])],
    temperature: 0,
    seed: null,
  };
}
