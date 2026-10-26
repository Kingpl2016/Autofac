// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import {
  EMPTY_STATUS,
  type RecordingResult,
  type RecordingStatus,
  type UniversePlan,
} from "../../lib/types";
import { RecordConsole } from "../RecordConsole";

const snap = (universe: number, activeChannels: number): UniverseSnapshot => ({
  universe,
  protocol: "artNet",
  sourceIps: [],
  sourceCount: 0,
  activeChannels,
  conflictChannels: 0,
  totalPackets: 1,
  packetRate: 0,
  sources: [],
});

const live = (over: Partial<RecordingStatus> = {}): RecordingStatus => ({
  ...EMPTY_STATUS,
  recording: true,
  path: "D:/rec/x.artrec.part",
  part: 1,
  elapsedUs: 83_400_000,
  universes: [1, 2],
  stats: { ...EMPTY_STATUS.stats, frames: 321, bytes: 2048, filteredPackets: 7 },
  ...over,
});

const PLAN: UniversePlan = { accepted: [1, 2], rejectedOutOfRange: [], rejectedOverCapacity: [] };

function setup(props: Partial<React.ComponentProps<typeof RecordConsole>> = {}) {
  const onStart = vi.fn();
  const onStop = vi.fn();
  const onNameChange = vi.fn();
  render(
    <RecordConsole
      status={EMPTY_STATUS}
      last={null}
      busy={null}
      playbackLoaded={false}
      snapshots={[]}
      plan={PLAN}
      sourceCount={0}
      name=""
      notes=""
      onNameChange={onNameChange}
      onNotesChange={vi.fn()}
      onStart={onStart}
      onStop={onStop}
      {...props}
    />,
  );
  return { onStart, onStop, onNameChange };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("RecordConsole", () => {
  it("待机：显示提示与“开始录制”，点击触发 onStart", () => {
    const { onStart } = setup();
    expect(screen.getByText("待机")).toBeTruthy();
    expect(screen.getByText("0:00.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("录制中：显示大号时间码、实时指标与停止按钮", () => {
    const { onStop } = setup({ status: live() });
    expect(screen.getByText("1:23.4")).toBeTruthy();
    expect(screen.getByText("321")).toBeTruthy();
    expect(screen.getByText("2.0 KiB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("录制中按活跃通道数显示 Universe 活动条", () => {
    setup({ status: live(), snapshots: [snap(1, 256), snap(2, 0)] });
    const chips = screen.getAllByTitle(/^Universe \d+：/);
    expect(chips.map((c) => c.getAttribute("title"))).toEqual([
      "Universe 1：256 个通道有输出",
      "Universe 2：0 个通道有输出",
    ]);
  });

  it("丢帧大于 0 时同时给出文字警告，而不只是变色", () => {
    setup({ status: live({ dropped: 5 }) });
    expect(screen.getByText(/已丢弃 5 帧/)).toBeTruthy();
  });

  it("停止中：按钮显示“正在保存…”并禁用", () => {
    setup({ status: live(), busy: "stop" });
    const btn = screen.getByRole("button", { name: "正在保存…" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("回放模式下禁用开始并提示原因", () => {
    setup({ playbackLoaded: true });
    expect((screen.getByRole("button", { name: "开始录制" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/已进入回放模式/)).toBeTruthy();
  });

  it("待机时显示来源 / 活跃 Universe / 将录制数量，以及“将录制”预览", () => {
    setup({ sourceCount: 3, snapshots: [snap(1, 10), snap(2, 20), snap(3, 30)] });
    const dl = screen.getByText("检测到的来源").closest("dl")!;
    expect(dl.textContent).toContain("3");
    expect(screen.getByText("将录制 2 个 Universe")).toBeTruthy();
  });

  it("没有可录制的 Universe 时给出警告徽标", () => {
    setup({ plan: { accepted: [], rejectedOutOfRange: [2500], rejectedOverCapacity: [] } });
    expect(screen.getByText("当前没有可录制的 Universe")).toBeTruthy();
    expect(screen.getByText(/2500/)).toBeTruthy();
  });

  it("节目名称是受控输入，录制中被锁定", () => {
    const { onNameChange } = setup();
    fireEvent.change(screen.getByLabelText("节目名称"), { target: { value: "彩排" } });
    expect(onNameChange).toHaveBeenCalledWith("彩排");
    cleanup();
    setup({ status: live() });
    expect((screen.getByLabelText("节目名称") as HTMLInputElement).disabled).toBe(true);
  });

  it("空闲且有上次结果：显示结果摘要与文件路径", () => {
    const last: RecordingResult = {
      files: [{ path: "D:/rec/a.artrec", durationUs: 5_000_000, frames: 10, bytes: 1024, sources: [] }],
      error: null,
      dropped: 0,
      stoppedBy: null,
    };
    setup({ last });
    expect(screen.getByText("上次录制")).toBeTruthy();
    expect(screen.getByText("0:05.0")).toBeTruthy();
    expect(screen.getByText("D:/rec/a.artrec")).toBeTruthy();
  });

  it("剩余空间不足以开始时：禁用开始、给出带数值的持续说明，并与按钮关联", () => {
    setup({
      disk: { path: "D:/rec", freeBytes: 320_000_000, level: "low", canStart: false },
    });
    const btn = screen.getByRole("button", { name: "开始录制" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const help = screen.getByText(/录制目录剩余 320 MB，至少需要 500 MB/);
    expect(btn.getAttribute("aria-describedby")).toBe(help.closest("p")!.id);
  });

  it("空间偏低但仍可开始时：开始可用，指标用文字标明“偏低”", () => {
    setup({
      disk: { path: "D:/rec", freeBytes: 800_000_000, level: "low", canStart: true },
    });
    expect((screen.getByRole("button", { name: "开始录制" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("800 MB · 偏低")).toBeTruthy();
  });

  it("空间充足时显示剩余空间，无法查询时不显示该指标", () => {
    setup({ disk: { path: "D:/rec", freeBytes: 5_000_000_000, level: "ok", canStart: true } });
    expect(screen.getByText("5.0 GB")).toBeTruthy();
    cleanup();
    setup({ disk: null });
    expect(screen.queryByText("剩余空间")).toBeNull();
  });

  it("录制中显示后端推送的实时剩余空间", () => {
    setup({ status: live({ diskFreeBytes: 2_500_000_000, diskLevel: "ok" }) });
    expect(screen.getByText("2.5 GB")).toBeTruthy();
  });

  it("因磁盘空间被自动停止时：用 alert 角色持续提示，不依赖会消失的 toast", () => {
    const last: RecordingResult = {
      files: [{ path: "D:/rec/a.artrec", durationUs: 5_000_000, frames: 10, bytes: 1024, sources: [] }],
      error: null,
      dropped: 0,
      stoppedBy: "disk",
    };
    setup({ last });
    expect(screen.getByRole("alert").textContent).toContain("因磁盘空间不足，录制已自动停止并保存");
  });
});
