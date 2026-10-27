// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { createEmptyProject } from "../../lib/project";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { MarkerStrip } from "../../timeline/MarkerStrip";
import { BeatAnalysisPanel } from "../BeatAnalysisPanel";

const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  const p = createEmptyProject("t");
  p.durationMs = 60_000;
  p.media.push({ id: "m", kind: "audio", path: "D:/歌.mp3", name: "歌.mp3", durationMs: 60_000 });
  p.mediaTracks.push({ id: "t", kind: "audio", name: "音频 1", mute: false, solo: false, lock: false, volume: 1 });
  p.mediaClips.push({ id: "c", trackId: "t", mediaId: "m", startMs: 2000, inMs: 0, durationMs: 58_000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
  useProjectStore.getState().load(p);
  useAnnouncerStore.setState({ message: "", seq: 0 });
  useEditorUiStore.setState({ playheadMs: 0 });
});

afterEach(() => cleanup());

describe("从音乐分析节拍", () => {
  it("分析主素材，按片段位置换算后应用速度与段落（一步撤销）", async () => {
    invoke.mockResolvedValue({
      bpm: 128,
      offsetMs: 100,
      beatsPerBar: 4,
      beatsMs: [],
      confidence: 0.86,
      durationMs: 60_000,
      sections: [
        { startMs: 0, endMs: 30_000, energy: 0.2 },
        { startMs: 30_000, endMs: 60_000, energy: 0.9 },
      ],
    });
    render(<BeatAnalysisPanel />);
    fireEvent.click(screen.getByRole("button", { name: "分析 歌.mp3 的节拍" }));
    await waitFor(() => expect(screen.getByText("128 BPM · 置信度 86% · 2 个段落")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("media_analyze_beats", { path: "D:/歌.mp3" });

    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByRole("button", { name: "应用速度和 2 个段落" }));
    // 强拍在时间线 100 + 2000 = 2100 ms，规整到一小节（128 BPM 一小节 1875 ms）内为 225 ms
    expect(project().tempo).toEqual({ bpm: 128, offsetMs: 225, beatsPerBar: 4 });
    expect(project().sections.map((s) => [s.name, s.startMs, s.endMs])).toEqual([
      ["安静段 1", 2000, 32_000],
      ["高潮 1", 32_000, 60_000],
    ]);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect(useAnnouncerStore.getState().message).toBe("已设置为 128 BPM，并生成 2 个段落");
  });

  it("没有稳定节拍时提示；置信度低时给出警告；没有素材时按钮不可用", async () => {
    invoke.mockRejectedValueOnce("no_beat");
    render(<BeatAnalysisPanel />);
    fireEvent.click(screen.getByRole("button", { name: /分析/ }));
    await waitFor(() => expect(screen.getByText(/没有检测到稳定的节拍/)).toBeTruthy());

    invoke.mockResolvedValueOnce({ bpm: 90, offsetMs: 0, beatsPerBar: 4, beatsMs: [], confidence: 0.2, durationMs: 60_000, sections: [] });
    fireEvent.click(screen.getByRole("button", { name: /分析/ }));
    await waitFor(() => expect(screen.getByText(/置信度较低/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "应用速度和 0 个段落" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "应用速度" }));
    expect(project().tempo?.bpm).toBe(90);

    cleanup();
    act(() => useProjectStore.getState().load(createEmptyProject("空")));
    render(<BeatAnalysisPanel />);
    expect(screen.getByRole("button", { name: "先导入音乐" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("段落色带", () => {
  it("点击定位、双击设为循环区间、Delete 删除", () => {
    act(() =>
      useProjectStore.getState().update((d) => {
        d.sections.push({ id: "s", name: "副歌", startMs: 10_000, endMs: 20_000, color: [255, 0, 0] });
      }),
    );
    render(<MarkerStrip />);
    const band = within(screen.getByRole("group", { name: /标记/ })).getByRole("button", { name: /段落 副歌/ });
    fireEvent.click(band);
    expect(useEditorUiStore.getState().playheadMs).toBe(10_000);
    fireEvent.doubleClick(band);
    expect(project().loopRange).toEqual({ startMs: 10_000, endMs: 20_000 });
    expect(useAnnouncerStore.getState().message).toBe("已循环段落 副歌");
    fireEvent.keyDown(band, { key: "Delete" });
    expect(project().sections).toEqual([]);
  });
});
