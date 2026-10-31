import { beforeEach, describe, expect, it, vi } from "vitest";

import { testAnalysis } from "../../lib/__tests__/analysisKit";

const api = vi.hoisted(() => ({
  mediaAnalyze: vi.fn(),
  mediaCancel: vi.fn(async () => undefined),
}));
vi.mock("../../lib/mediaApi", async (orig) => ({ ...(await orig<typeof import("../../lib/mediaApi")>()), ...api }));
vi.mock("@/features/ai/lib/api", () => ({
  aiHistoryRead: async () => null,
  aiHistoryWrite: async () => undefined,
  aiHistoryLibraryPath: async (e: string) => e,
}));

import { useAiChatStore } from "../useAiChatStore";
import { useMediaAnalysisStore } from "../useMediaAnalysisStore";

const media = { id: "m1", path: "D:/a.mp3" };

beforeEach(() => {
  vi.clearAllMocks();
  useMediaAnalysisStore.setState({ entries: {} });
  useAiChatStore.setState({ media: {}, path: null });
});

describe("素材分析状态", () => {
  it("同一文件、同一灵敏度只分析一次；并发请求共用一次", async () => {
    api.mediaAnalyze.mockResolvedValue(testAnalysis());
    const [a, b] = await Promise.all([useMediaAnalysisStore.getState().ensure(media), useMediaAnalysisStore.getState().ensure(media)]);
    expect(a?.beats.bpm).toBe(120);
    expect(b).toBe(a);
    expect(api.mediaAnalyze).toHaveBeenCalledTimes(1);
    await useMediaAnalysisStore.getState().ensure(media);
    expect(api.mediaAnalyze).toHaveBeenCalledTimes(1);
  });

  it("重新分析：新结果出来前旧结果照常可用；失败时保留旧结果并记下错误；灵敏度跟着工程保存", async () => {
    api.mediaAnalyze.mockResolvedValueOnce(testAnalysis());
    await useMediaAnalysisStore.getState().ensure(media);
    const old = useMediaAnalysisStore.getState().entries.m1.audio;

    let fail: (e: unknown) => void = () => {};
    api.mediaAnalyze.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    const pending = useMediaAnalysisStore.getState().reanalyze(media, 1.5);
    expect(useMediaAnalysisStore.getState().entries.m1).toMatchObject({ status: "ready", refreshing: true, audio: old, sensitivity: 1.5 });
    expect(useAiChatStore.getState().media.m1.prefs?.sensitivity).toBe(1.5);
    fail("decode");
    expect(await pending).toBe(false);
    expect(useMediaAnalysisStore.getState().entries.m1).toMatchObject({ status: "ready", refreshing: false, audio: old, error: "decode" });

    const fresh = testAnalysis({ sensitivity: 1.5 });
    api.mediaAnalyze.mockResolvedValueOnce(fresh);
    expect(await useMediaAnalysisStore.getState().reanalyze(media, 1.5)).toBe(true);
    expect(useMediaAnalysisStore.getState().entries.m1.audio).toEqual(fresh);
  });

  it("只读缓存：有缓存直接可用；没有缓存记成“未分析”而不分析，之后手动开始才分析", async () => {
    api.mediaAnalyze.mockImplementation(async (_p: string, _s: number, _id?: string, cachedOnly?: boolean) => {
      if (cachedOnly) throw "not_cached";
      return testAnalysis();
    });
    expect(await useMediaAnalysisStore.getState().peek(media)).toBeNull();
    expect(useMediaAnalysisStore.getState().entries.m1).toMatchObject({ status: "none", audio: null });
    expect(api.mediaAnalyze).toHaveBeenCalledTimes(1);
    expect(api.mediaAnalyze.mock.calls[0][3]).toBe(true);
    // 再看一次不会重复查
    await useMediaAnalysisStore.getState().peek(media);
    expect(api.mediaAnalyze).toHaveBeenCalledTimes(1);
    // 手动开始：真正分析
    expect((await useMediaAnalysisStore.getState().ensure(media))?.beats.bpm).toBe(120);
    expect(api.mediaAnalyze.mock.calls[1][3]).not.toBe(true);
    expect(useMediaAnalysisStore.getState().entries.m1.status).toBe("ready");
    api.mediaAnalyze.mockReset();

    // 有缓存：直接可用
    api.mediaAnalyze.mockResolvedValueOnce(testAnalysis());
    expect((await useMediaAnalysisStore.getState().peek({ id: "m9", path: "D:/z.mp3" }))?.beats.bpm).toBe(120);
    expect(useMediaAnalysisStore.getState().entries.m9.status).toBe("ready");
  });

  it("第一次就失败：记为错误；版本不对的结果当作失败；取消时通知后端", async () => {
    api.mediaAnalyze.mockRejectedValueOnce("no_beat");
    expect(await useMediaAnalysisStore.getState().ensure(media)).toBeNull();
    expect(useMediaAnalysisStore.getState().entries.m1).toMatchObject({ status: "error", error: "no_beat", audio: null });

    api.mediaAnalyze.mockResolvedValueOnce(testAnalysis({ version: 99 }));
    expect(await useMediaAnalysisStore.getState().reanalyze({ id: "m2", path: "D:/b.mp3" }, 1)).toBe(false);

    api.mediaAnalyze.mockReturnValueOnce(new Promise(() => {}));
    void useMediaAnalysisStore.getState().ensure({ id: "m3", path: "D:/c.mp3" });
    await Promise.resolve();
    useMediaAnalysisStore.getState().cancel("m3");
    expect(api.mediaCancel).toHaveBeenCalledTimes(1);
    expect(useMediaAnalysisStore.getState().entries.m3).toMatchObject({ status: "error", error: "cancelled" });
  });
});
