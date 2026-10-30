import { describe, expect, it, vi } from "vitest";

import { callSettings, createLanguageModel, PLACEHOLDER_API_KEY } from "../model";
import { aiErrorText, isAiAbort, toAiError } from "../errors";
import { inputFromPreset, PROVIDER_PRESETS } from "../presets";

const base = { model: "m", supportsStructuredOutputs: false } as const;

/** 记录请求的假 fetch：回一个最小的成功响应体（不关心内容，只看请求）。 */
function recordingFetch() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers });
    return new Response("{}", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("createLanguageModel", () => {
  it.each([
    ["openaiCompatible", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions", "authorization"],
    ["anthropic", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages", "x-api-key"],
    ["google", "https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent", "x-goog-api-key"],
  ] as const)("%s：请求发往接口地址之下，并带占位 Key", async (kind, baseUrl, url, header) => {
    const { fetch, calls } = recordingFetch();
    const model = createLanguageModel({ ...base, kind, baseUrl }, fetch);
    if (typeof model === "string") throw new Error("应为模型实例");
    await Promise.resolve(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).catch(
      () => undefined,
    );
    expect(calls[0].url).toBe(url);
    expect(calls[0].headers.get(header)).toContain(PLACEHOLDER_API_KEY);
  });

  it("生成参数：温度来自配置，种子只在设置时带上", () => {
    expect(callSettings({ temperature: 0, seed: null })).toEqual({ temperature: 0 });
    expect(callSettings({ temperature: 0.2, seed: 42 })).toEqual({ temperature: 0.2, seed: 42 });
  });

  it("预设生成的初始配置温度为 0", () => {
    for (const p of PROVIDER_PRESETS) {
      const input = inputFromPreset(p);
      expect(input.temperature).toBe(0);
      expect(input.model).not.toBe("");
      expect(input.baseUrl.endsWith("/")).toBe(false);
    }
  });
});

describe("errors", () => {
  const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key)) as never;

  it("识别后端错误、SDK 的 HTTP 错误、中止与嵌套原因", () => {
    expect(toAiError({ code: "timeout", message: "x" }).code).toBe("timeout");
    expect(toAiError({ name: "AI_APICallError", statusCode: 401, message: "bad key" })).toMatchObject({ code: "http", status: 401 });
    expect(isAiAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(toAiError({ name: "AI_RetryError", message: "x", cause: { code: "network", message: "y" } }).code).toBe("network");
    expect(toAiError({ name: "AI_NoObjectGeneratedError", message: "x" }).code).toBe("no_object");
    expect(toAiError("boom")).toEqual({ code: "unknown", message: "boom" });
  });

  it("文案：已知码走语言包，HTTP 带状态码，未知显示原文", () => {
    expect(aiErrorText(t, { code: "network", message: "x" })).toBe("ai.errors.network");
    expect(aiErrorText(t, { statusCode: 429, message: "slow down" })).toContain("429");
    expect(aiErrorText(t, new Error("原始描述"))).toBe("原始描述");
  });
});
