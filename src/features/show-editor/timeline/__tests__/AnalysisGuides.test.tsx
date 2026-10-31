// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";

vi.mock("../../lib/mediaApi", async (orig) => ({
  ...(await orig<typeof import("../../lib/mediaApi")>()),
  mediaAnalyze: vi.fn(async () => (await import("../../lib/__tests__/analysisKit")).testAnalysis()),
  mediaCancel: vi.fn(async () => undefined),
}));
vi.mock("@/features/ai/lib/api", () => ({ aiHistoryRead: async () => null, aiHistoryWrite: async () => undefined, aiHistoryLibraryPath: async (e: string) => e }));
// jsdom 没有布局：给参考线层一个宽度
vi.mock("@/shared/hooks/useElementSize", () => ({ useElementSize: () => ({ width: 1000, height: 200 }) }));

import { collectSnapTargets } from "../../lib/snap";
import { createEmptyProject } from "../../lib/project";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { analysisSnapTimes, useMediaAnalysisStore } from "../../stores/useMediaAnalysisStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { AnalysisGuides } from "../AnalysisGuides";
import { mediaAnalyze } from "../../lib/mediaApi";
import { guideMarks } from "../analysisGuideMarks";
import { START_LEFT } from "../timelineData";
import { useTimelineScrollStore } from "../timelineScrollStore";

const withMedia = produce(createEmptyProject("t"), (d) => {
  d.durationMs = 64_000;
  d.media = [{ id: "m1", kind: "audio", path: "D:/song.mp3", name: "song.mp3", durationMs: 64_000 }];
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  stubResizeObserver();
  useProjectStore.getState().load(withMedia);
  useMediaAnalysisStore.setState({ entries: {} });
  useAiChatStore.setState({ media: {}, path: null });
  useEditorPrefsStore.setState({ aiGuides: true });
  useEditorUiStore.setState({ pxPerSec: 10 });
  useTimelineScrollStore.setState({ left: 0 });
});
afterEach(() => cleanup());

describe("音乐分析参考线", () => {
  it("只保留可见范围内的线；重拍太多时按强度保留", () => {
    const view = { scrollLeft: 0, width: 200, pxPerSec: 10 };
    const marks = guideMarks(
      [
        { kind: "build", atMs: 8000, endMs: 16_000, strength: 0.5 },
        { kind: "drop", atMs: 16_000, strength: 1 },
        { kind: "cut", atMs: 60_000, strength: 1 },
      ],
      view,
    );
    expect(marks.map((m) => [m.kind, m.x, m.width])).toEqual([
      ["build", START_LEFT + 80, 80],
      ["drop", START_LEFT + 160, undefined],
    ]);
    const many = Array.from({ length: 900 }, (_, i) => ({ kind: "hit" as const, atMs: i * 10, strength: i % 2 }));
    const kept = guideMarks(many, { scrollLeft: 0, width: 10_000, pxPerSec: 100 });
    expect(kept).toHaveLength(400);
    expect(kept.every((m) => m.strength === 1)).toBe(true);
  });

  it("显示时只读缓存，不做分析；段落标签可以改，改过的以用户的为准并可恢复；关掉时不显示", async () => {
    render(<AnalysisGuides />);
    await act(async () => {});
    // 导入素材 / 打开工程时只查缓存（cachedOnly），不会在后台分析
    expect(vi.mocked(mediaAnalyze).mock.calls.every((c) => c[3] === true)).toBe(true);
    const label = await screen.findByRole("button", { name: "段落标签：B" });
    fireEvent.click(label);
    const input = await screen.findByLabelText("段落标签");
    fireEvent.change(input, { target: { value: "副歌" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(useAiChatStore.getState().media.m1.prefs?.labels).toEqual({ "16000": "副歌" });
    expect(await screen.findByRole("button", { name: "段落标签：副歌" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "段落标签：副歌" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复分析结果" }));
    expect(useAiChatStore.getState().media.m1.prefs?.labels).toEqual({});

    act(() => {
      useEditorPrefsStore.setState({ aiGuides: false });
    });
    expect(screen.queryByTestId("analysis-guides")).toBeNull();
  });

  it("吸附点里有音乐事件（关掉事件吸附时没有）", async () => {
    await useMediaAnalysisStore.getState().ensure({ id: "m1", path: "D:/song.mp3" });
    const times = analysisSnapTimes(useProjectStore.getState().project);
    expect(times).toContain(16_000);
    expect(times).toContain(8000);
    const project = useProjectStore.getState().project;
    expect(collectSnapTargets(project, 0, new Set(), { beats: false, markers: false, edges: false, playhead: false }, [12_345])).toContain(12_345);
    expect(collectSnapTargets(project, 0, new Set(), { beats: false, markers: false, edges: false, playhead: false, events: false }, [12_345])).not.toContain(12_345);
  });
});
