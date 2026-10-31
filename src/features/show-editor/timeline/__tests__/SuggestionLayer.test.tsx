// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));

import i18n from "@/shared/i18n";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type StaticCue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { useAiStagingStore } from "../../stores/useAiStagingStore";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { SuggestionLayer } from "../SuggestionLayer";

const cue = (trackId: string, id: string, startMs: number): StaticCue => ({
  id,
  kind: "static",
  trackId,
  startMs,
  endMs: startMs + 2000,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  rgb: [0, 0, 255],
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 16_000;
      const tr = d.tracks[0].id;
      d.cues.push(cue(tr, "a", 0), cue(tr, "b", 2000), cue(tr, "c", 4000));
    }),
  );
  useEditorPrefsStore.setState({ aiSuggestions: true });
  useAiStagingStore.setState({ staged: null });
  useAiChatStore.setState({ dismissedSuggestions: [] });
  useEditorUiStore.setState({ playheadMs: 1000, selectedCueIds: [], timeRange: null, selectedTimelineObject: null, selectedMediaClipIds: [] });
});

afterEach(() => cleanup());

const renderLayer = () => {
  const ids = useProjectStore.getState().project.tracks.map((t) => t.id);
  return render(
    <SuggestionLayer
      trackIndex={new Map(ids.map((id, i) => [id, i]))}
      layout={{ tops: ids.map((_, i) => i * 40), heights: ids.map(() => 40), total: ids.length * 40 }}
      rowFrom={0}
      rowTo={ids.length}
      timeFrom={0}
      timeTo={16_000}
      xOf={(ms) => ms / 10}
    />,
  );
};

describe("时间线上的主动建议", () => {
  it("显示卡片与点线虚影；采纳后写入工程", () => {
    const { container } = renderLayer();
    expect(screen.getByRole("group", { name: /连续 3 个片段完全一样/ })).toBeTruthy();
    expect(container.querySelectorAll("[data-suggestion-ghost]").length).toBe(1);
    act(() => fireEvent.click(screen.getByRole("button", { name: "采纳建议" })));
    expect(useProjectStore.getState().project.cues.find((c) => c.id === "b")?.brightness).toBe(60);
  });

  it("没有选择时 Esc 忽略当前建议（跟着工程记下）；有选择时 Esc 留给取消选择", () => {
    renderLayer();
    useEditorUiStore.setState({ selectedCueIds: ["a"] });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAiChatStore.getState().dismissedSuggestions).toEqual([]);
    useEditorUiStore.setState({ selectedCueIds: [] });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAiChatStore.getState().dismissedSuggestions).toHaveLength(1);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("关掉建议或有待审阅的改动时不显示", () => {
    useEditorPrefsStore.setState({ aiSuggestions: false });
    renderLayer();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
