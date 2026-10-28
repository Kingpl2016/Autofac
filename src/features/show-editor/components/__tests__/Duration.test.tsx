// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { Ruler } from "../../timeline/Ruler";
import { DurationConfirmDialog } from "../DurationConfirmDialog";
import { TransportBar } from "../TransportBar";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 60_000;
      addStaticCue(d, d.tracks[0].id, 20_000, { lengthMs: 10_000 });
    }),
  );
  useEditorUiStore.setState({ durationRequest: null, playheadMs: 0, pxPerSec: 100 });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});
afterEach(() => cleanup());

function Harness() {
  return (
    <>
      <TransportBar />
      <Ruler />
      <DurationConfirmDialog />
    </>
  );
}

describe("设置节目时长", () => {
  it("在工具条输入新时长；延长直接生效，缩短会裁掉内容时先确认", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: /节目总时长/ });
    fireEvent.change(input, { target: { value: "2:30" } });
    fireEvent.blur(input);
    expect(project().durationMs).toBe(150_000);
    expect(useAnnouncerStore.getState().message).toBe("节目时长已设为 02:30.00");

    fireEvent.change(input, { target: { value: "0:25" } });
    fireEvent.blur(input);
    expect(project().durationMs).toBe(150_000);
    const dialog = screen.getByRole("dialog", { name: "把节目缩短到 00:25.00？" });
    expect(within(dialog).getByText(/裁短 1 个片段/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(project().durationMs).toBe(150_000);

    fireEvent.change(input, { target: { value: "0:25" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "裁掉超出部分" }));
    expect(project().durationMs).toBe(25_000);
    expect(project().cues[0].endMs).toBe(25_000);

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(useAnnouncerStore.getState().message).toMatch(/无法识别/);
  });

  it("拖动标尺上的节目结尾把手；方向键调整", () => {
    render(<Harness />);
    const handle = screen.getByRole("slider", { name: /节目结尾/ });
    // pxPerSec = 100，START_LEFT = 20：x = 20 + 秒 × 100
    fireEvent.pointerDown(handle, { button: 0, clientX: 20 + 6000, pointerId: 3 });
    fireEvent.pointerMove(handle, { clientX: 20 + 9000, pointerId: 3 });
    fireEvent.pointerUp(handle, { pointerId: 3 });
    expect(project().durationMs).toBe(90_000);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(project().durationMs).toBe(91_000);
  });
});
