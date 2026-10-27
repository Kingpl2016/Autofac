// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { CueInspector } from "../CueInspector";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  loadTestEngine();
});

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();
const cue = () => project().cues[0];

let id = "";
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 10_000;
      id = addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 4000, rgb: [255, 0, 0] }) ?? "";
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [id], playheadMs: 2000 });
});

afterEach(() => cleanup());

const setNumber = (name: string | RegExp, value: string) => {
  const input = screen.getByRole("textbox", { name });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe("外观片段的关键帧", () => {
  it("静态 Cue 一键转换；打关键帧、移动播放头后改值自动打帧，显示的是引擎插值", () => {
    render(<CueInspector />);
    fireEvent.click(screen.getByRole("button", { name: "转换为外观片段（1）" }));
    expect(cue().kind).toBe("look");

    const intensityKey = () => screen.getByRole("button", { name: "在播放头处添加 / 删除强度关键帧" });
    expect(intensityKey().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(intensityKey());
    expect(intensityKey().getAttribute("aria-pressed")).toBe("true");

    // 播放头移到片段内 3 秒处：改值即打第二帧
    act(() => ui().setPlayhead(4000));
    setNumber("强度数值", "0");
    const look = cue().kind === "look" ? cue() : null;
    expect(look?.kind === "look" && look.look.intensity).toMatchObject({
      kind: "keys",
      keys: [
        { tMs: 1000, value: 100 },
        { tMs: 3000, value: 0 },
      ],
    });
    // 两帧中间：引擎线性插值 50%
    act(() => ui().setPlayhead(3000));
    expect((screen.getByRole("textbox", { name: "强度数值" }) as HTMLInputElement).value).toBe("50");
    expect(screen.getByText("2 帧")).toBeTruthy();
    // 导航到上一帧
    fireEvent.click(screen.getByRole("button", { name: "跳到上一个关键帧" }));
    expect(ui().playheadMs).toBe(2000);
    // 区段过渡方式
    expect(screen.getByRole("combobox", { name: "强度当前区段的过渡方式" })).toBeTruthy();
  });

  it("切换为数值曲线并调参数；播放头在片段外时不能打关键帧", () => {
    render(<CueInspector />);
    fireEvent.click(screen.getByRole("button", { name: "转换为外观片段（1）" }));
    fireEvent.click(screen.getByRole("radio", { name: "曲线" }));
    const c = cue();
    expect(c.kind === "look" && c.look.intensity?.kind).toBe("curve");
    setNumber("次数", "4");
    const after = cue();
    expect(after.kind === "look" && after.look.intensity?.kind === "curve" && after.look.intensity.curve.cycles).toBe(4);

    act(() => ui().setPlayhead(8000));
    expect(screen.getByText(/播放头不在这个片段内/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "在播放头处添加 / 删除颜色关键帧" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
