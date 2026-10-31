import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

import { mapAnalysis } from "../../lib/mediaAnalysis";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { tagMedia } from "../mediaTags";
import { excerptPlan, MAX_TAG_EXCERPTS, tagsFromAnswer, uploadBytes } from "../mediaTagsPlan";

const analysis = mapAnalysis({ media: { id: "m", name: "song.mp3" }, clip: null, audio: testAnalysis() })!;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe("多模态标注", () => {
  it("每个段落取中间 12 秒；段落太多时均匀取 8 个；上传量在代理上限以内", () => {
    const plan = excerptPlan(analysis);
    expect(plan.map((p) => [p.index, p.startMs, p.lengthMs])).toEqual([
      [1, 2000, 12_000],
      [2, 26_000, 12_000],
      [3, 50_000, 12_000],
    ]);
    const many = { ...analysis, sections: Array.from({ length: 20 }, (_, i) => ({ ...analysis.sections[0], startMs: i * 4000, endMs: i * 4000 + 4000, sourceStartMs: i * 4000 })) };
    const picked = excerptPlan(many);
    expect(picked).toHaveLength(MAX_TAG_EXCERPTS);
    expect(picked[0].index).toBe(1);
    expect(picked.at(-1)!.index).toBe(20);
    expect(picked[0].lengthMs).toBe(4000);
    // 8 段 × 12 秒的 WAV 加 8 张关键帧，Base64 后仍小于 8 MiB
    const full = excerptPlan({ ...analysis, sections: Array.from({ length: 8 }, (_, i) => ({ ...analysis.sections[0], startMs: i * 20_000, endMs: i * 20_000 + 20_000, sourceStartMs: i * 20_000 })) });
    expect((uploadBytes(full, true, true) * 4) / 3).toBeLessThan(8 * 1024 * 1024);
  });

  it("回答换成标注：只保留可信的、发出去的段落的角色，按素材内起点记", () => {
    const plan = excerptPlan(analysis);
    const tags = tagsFromAnswer(
      {
        genre: " synth pop ",
        mood: "uplifting",
        vocals: true,
        sections: [
          { index: 1, role: "verse", confidence: 0.8 },
          { index: 2, role: "chorus", confidence: 0.4 },
          { index: 9, role: "outro", confidence: 1 },
        ],
      },
      plan,
    );
    expect(tags).toEqual({ genre: "synth pop", mood: "uplifting", vocals: true, roles: { "0": "verse" } });
  });

  it("把片段与提示词一起发给模型，用结构化输出解析回答", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ genre: "edm", mood: "energetic", vocals: false, sections: [{ index: 2, role: "drop", confidence: 0.9 }] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const tags = await tagMedia({
      loaded: { model, profile: {} as never, settings: { temperature: 0 } },
      analysis,
      excerpts: async (plan) => plan.map((_, i) => (i === 1 ? "UklGRg==" : "")),
    });
    expect(tags).toEqual({ tags: { genre: "edm", mood: "energetic", vocals: false, roles: { "16000": "drop" } }, dropped: [] });
    const prompt = model.doGenerateCalls[0].prompt;
    const parts = prompt.flatMap((m): { type: string }[] => (Array.isArray(m.content) ? (m.content as { type: string }[]) : []));
    expect(parts.filter((p) => p.type === "file")).toHaveLength(1);
    expect(JSON.stringify(parts)).toContain("relative energy");
    // 什么都没有可发时不调用模型
    expect(await tagMedia({ loaded: { model, profile: {} as never, settings: { temperature: 0 } }, analysis, excerpts: async (p) => p.map(() => "") })).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("模型拒绝音频（422 unknown variant input_audio）：去掉音频只发画面再试一次；只有音频时报错", async () => {
    const rejectAudio = Object.assign(new Error("unknown variant `input_audio`, expected one of `text`, `image_url`, `file`"), {
      name: "AI_APICallError",
      statusCode: 422,
    });
    const answer = { genre: "pop", mood: "calm", vocals: true, sections: [] };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const parts = options.prompt.flatMap((m): { type: string; mediaType?: string }[] => (Array.isArray(m.content) ? (m.content as { type: string }[]) : []));
        if (parts.some((p) => p.type === "file" && p.mediaType?.startsWith("audio/"))) throw rejectAudio;
        return { content: [{ type: "text", text: JSON.stringify(answer) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    const loaded = { model, profile: {} as never, settings: { temperature: 0 } };
    const out = await tagMedia({ loaded, analysis, excerpts: async (p) => p.map(() => "UklGRg=="), frames: async (p) => p.map(() => "/9j/") });
    expect(out?.dropped).toEqual(["audio"]);
    expect(out?.tags.genre).toBe("pop");
    await expect(tagMedia({ loaded, analysis, excerpts: async (p) => p.map(() => "UklGRg==") })).rejects.toThrow(/input_audio/);
  });
});
