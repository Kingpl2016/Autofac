// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addFixtures } from "../../lib/ops";
import type { FrameImage } from "../../lib/pixelMap";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useMediaStore } from "../../stores/useMediaStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { PixelMapPanel, type OpenFrameSource } from "../PixelMapPanel";

beforeAll(() => loadTestEngine());

const project = () => useProjectStore.getState().project;
const clip = () => project().mediaClips[0];

/** 左半红、右半蓝的 8×1 画面。 */
const FRAME: FrameImage = {
  width: 8,
  height: 1,
  data: Array.from({ length: 8 }, (_, x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255])).flat(),
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 10_000;
      d.fixtures[0].stage = { x: -6, y: 4 };
      d.fixtures[1].stage = { x: 6, y: 4 };
      d.fixtures[2].stage = { x: 6, y: 2 };
      d.media.push({ id: "v", kind: "video", path: "v.mp4", name: "v.mp4", durationMs: 5000 });
      d.mediaTracks.push({ id: "vt", kind: "video", name: "视频 1", mute: false, solo: false, lock: false, volume: 1 });
      d.mediaClips.push({ id: "c", trackId: "vt", mediaId: "v", startMs: 1000, inMs: 0, durationMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
    }),
  );
  useMediaStore.getState().reset();
  useMediaStore.getState().set("v", { path: "v.mp4", status: "ready", url: "asset://v.mp4" });
  useEditorUiStore.setState({ selectedFixtureIds: [], selectedCueIds: [] });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

describe("像素映射面板", () => {
  it("给选中的灯按舞台位置取色，生成与视频片段同范围的场景片段并选中", async () => {
    act(() => useEditorUiStore.getState().setSelectedFixtures([project().fixtures[0].id, project().fixtures[1].id]));
    let disposed = false;
    const open: OpenFrameSource = async (url) => {
      expect(url).toBe("asset://v.mp4");
      return { grab: async () => FRAME, dispose: () => (disposed = true) };
    };
    render(<PixelMapPanel clip={clip()} open={open} />);
    expect(screen.getByText("按舞台位置给选中的 2 台灯取色")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "10" }));
    fireEvent.click(screen.getByRole("button", { name: "生成场景片段" }));
    await waitFor(() => expect(project().cues).toHaveLength(1));
    const scene = project().cues[0];
    expect(scene).toMatchObject({ kind: "scene", startMs: 1000, endMs: 2000, label: "像素映射 · v.mp4" });
    expect(scene.kind === "scene" && scene.entries.map((e) => [e.fixtureId, e.look.color])).toEqual([
      [project().fixtures[0].id, { kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } }],
      [project().fixtures[1].id, { kind: "value", value: { kind: "rgb", rgb: [0, 0, 255] } }],
    ]);
    expect(useEditorUiStore.getState().selectedCueIds).toEqual([scene.id]);
    expect(useAnnouncerStore.getState().message).toBe("已为 2 台灯生成像素映射场景片段");
    expect(disposed).toBe(true);
  });

  it("烘焙中显示进度并可取消；视频没准备好时不可用", async () => {
    let release: () => void = () => {};
    const open: OpenFrameSource = async () => ({
      grab: () => new Promise<FrameImage>((resolve) => (release = () => resolve(FRAME))),
    });
    render(<PixelMapPanel clip={clip()} open={open} />);
    expect(screen.getByText(/全部 3 台灯/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "生成场景片段" }));
    const bar = await screen.findByRole("progressbar", { name: "像素映射进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    await waitFor(() => expect(screen.getByRole("button", { name: "取消像素映射" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "取消像素映射" }));
    await act(async () => release());
    await waitFor(() => expect(useAnnouncerStore.getState().message).toBe("已取消像素映射"));
    expect(project().cues).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).toBeNull();

    cleanup();
    act(() => useMediaStore.getState().set("v", { path: "v.mp4", status: "loading" }));
    render(<PixelMapPanel clip={clip()} open={open} />);
    expect(screen.getByRole("button", { name: "生成场景片段" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/视频还在准备/)).toBeTruthy();
  });
});
