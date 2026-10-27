// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { CUE_TEMPLATES } from "../../lib/cueTemplates";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { TemplatesTab } from "../TemplatesTab";

const ui = () => useEditorUiStore.getState();
const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null, playheadMs: 0, clipboard: [] });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

const renderTab = () =>
  render(
    <DndContext>
      <TemplatesTab />
    </DndContext>,
  );

describe("TemplatesTab", () => {
  it("列出全部内置模板", () => {
    renderTab();
    expect(screen.getAllByRole("button")).toHaveLength(CUE_TEMPLATES.length);
    expect(screen.getByRole("button", { name: "红" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "白光渐入渐出" })).toBeTruthy();
  });

  it("点击模板：加到所选轨道的播放头处，带上模板的颜色并选中", () => {
    renderTab();
    const trackId = project().tracks[1].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(5000);
    });
    fireEvent.click(screen.getByRole("button", { name: "红" }));
    expect(project().cues).toHaveLength(1);
    const cue = project().cues[0];
    expect(cue).toMatchObject({ trackId, startMs: 5000, endMs: 7000, kind: "static" });
    expect(cue.kind === "static" && cue.rgb).toEqual([255, 0, 0]);
    expect(ui().selectedCueIds).toEqual([cue.id]);
    expect(useAnnouncerStore.getState().message).toBe("已添加 Cue");
  });

  it("带淡入淡出的模板保留淡入淡出", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "柔和暖光" }));
    expect(project().cues[0]).toMatchObject({ brightness: 60, fadeInMs: 1000, fadeOutMs: 1000 });
  });

  it("没有选中轨道时用第一条未锁定的轨道", () => {
    renderTab();
    act(() =>
      useProjectStore.getState().update((d) => {
        d.tracks[0].lock = true;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "蓝" }));
    expect(project().cues[0].trackId).toBe(project().tracks[1].id);
  });

  it("位置被占用时播报放不下；没有可用轨道时播报原因", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "绿" }));
    fireEvent.click(screen.getByRole("button", { name: "绿" }));
    expect(project().cues).toHaveLength(1);
    expect(useAnnouncerStore.getState().message).toBe("这个位置放不下新的 Cue");

    act(() =>
      useProjectStore.getState().update((d) => {
        for (const t of d.tracks) t.lock = true;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "黄" }));
    expect(useAnnouncerStore.getState().message).toBe("没有可用的轨道。先添加灯具，或解锁轨道");
  });
});
