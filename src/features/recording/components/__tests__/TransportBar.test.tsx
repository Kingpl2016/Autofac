// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { EMPTY_STATUS, type RecordingResult, type RecordingStatus } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { TransportBar } from "../TransportBar";

const live = (over: Partial<RecordingStatus> = {}): RecordingStatus => ({
  ...EMPTY_STATUS,
  recording: true,
  name: "舞台A-04",
  path: "D:/rec/x.artrec.part",
  part: 1,
  elapsedUs: 83_400_000,
  universes: [1, 2],
  stats: { ...EMPTY_STATUS.stats, frames: 321, bytes: 2048 },
  ...over,
});

const result = (over: Partial<RecordingResult> = {}): RecordingResult => ({
  files: [{ path: "D:/rec/a.artrec", durationUs: 5_000_000, frames: 10, bytes: 1024, sources: [] }],
  error: null,
  dropped: 0,
  stoppedBy: null,
  ...over,
});

function setup(props: Partial<React.ComponentProps<typeof TransportBar>> = {}) {
  const onStart = vi.fn();
  const onStop = vi.fn();
  const status = props.status ?? EMPTY_STATUS;
  // 时间码读 store 里的录制时钟
  useRecordingStore.setState({ status, statusAt: performance.now() });
  const view = render(
    <TransportBar
      status={status}
      last={null}
      busy={null}
      disk={null}
      sourceCount={3}
      activeCount={5}
      plannedCount={2}
      presetParts={["全部来源", "Universe 0-3"]}
      nextName="舞台A-05"
      onStart={onStart}
      onStop={onStop}
      {...props}
    />,
  );
  return { onStart, onStop, ...view };
}

const metricLabels = () =>
  within(screen.getByText("剩余空间").closest("dl")!)
    .getAllByRole("term")
    .map((dt) => dt.textContent);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useRecordingStore.setState({ status: EMPTY_STATUS, last: null });
});
afterEach(() => cleanup());

describe("TransportBar", () => {
  it("待机：时间码归零，4 个固定指标位，显示预设摘要与下一个名称", () => {
    const { onStart } = setup();
    expect(screen.getByText("待机")).toBeTruthy();
    expect(screen.getByText("0:00.0")).toBeTruthy();
    expect(metricLabels()).toEqual(["检测到的来源", "活跃 Universe", "将录制", "剩余空间"]);
    expect(screen.getByText(/全部来源 · Universe 0-3/)).toBeTruthy();
    expect(screen.getByText(/舞台A-05/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("录制中：仍是 4 个指标位，时间码取会话总时长，显示正在录制的名称", () => {
    const { onStop } = setup({
      status: live({ part: 2, elapsedUs: 5_000_000, sessionElapsedUs: 65_000_000, partStartsUs: [0, 60_000_000] }),
    });
    expect(metricLabels()).toEqual(["帧数", "文件大小", "丢帧", "剩余空间"]);
    expect(screen.getByText("1:05.0")).toBeTruthy();
    expect(screen.getByText(/第 2 段 · 0:05.0/)).toBeTruthy();
    expect(screen.getByText(/舞台A-04/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("停止中：按钮显示“正在保存…”并禁用", () => {
    setup({ status: live(), busy: "stop" });
    expect((screen.getByRole("button", { name: "正在保存…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("名称为空时说明只用时间戳", () => {
    setup({ nextName: "" });
    expect(screen.getByText(/仅时间戳/)).toBeTruthy();
  });

  it("剩余空间不足以开始：禁用开始，说明与按钮关联", () => {
    setup({ disk: { path: "D:/rec", freeBytes: 320_000_000, level: "low", canStart: false } });
    const btn = screen.getByRole("button", { name: "开始录制" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const help = screen.getByText(/录制目录剩余 320 MB，至少需要 500 MB/);
    expect(btn.getAttribute("aria-describedby")).toBe(help.id);
  });

  it("空间偏低但仍可开始：开始可用，指标用文字标明“偏低”；未知时显示占位", () => {
    setup({ disk: { path: "D:/rec", freeBytes: 800_000_000, level: "low", canStart: true } });
    expect((screen.getByRole("button", { name: "开始录制" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("800 MB · 偏低")).toBeTruthy();
    cleanup();
    setup({ disk: null });
    expect(screen.getByText("剩余空间").closest("div")!.textContent).toContain("—");
  });

  it("正常录完直接回到待机，不显示结果摘要", () => {
    setup({ last: result() });
    expect(screen.getByText("待机")).toBeTruthy();
    expect(screen.queryByText("D:/rec/a.artrec")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("因磁盘空间被迫停止：用 alert 持续提示，可手动关闭", () => {
    setup({ last: result({ stoppedBy: "disk" }) });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("因磁盘空间不足，录制已自动停止并保存");
    fireEvent.click(within(alert).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("上次录制有丢帧：文字告警可关闭；换一次结果后重新出现", () => {
    const first = result({ dropped: 4 });
    const { rerender } = setup({ last: first });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText(/已丢弃 4 帧/)).toBeNull();

    const props = {
      status: EMPTY_STATUS,
      busy: null,
      disk: null,
      sourceCount: 0,
      activeCount: 0,
      plannedCount: 0,
      presetParts: [],
      nextName: "",
      onStart: vi.fn(),
      onStop: vi.fn(),
    };
    rerender(<TransportBar {...props} last={result({ dropped: 2 })} />);
    expect(screen.getByText(/已丢弃 2 帧/)).toBeTruthy();
  });

  it("录制中有丢帧：指标标警告色并给出文字告警", () => {
    setup({ status: live({ dropped: 5 }) });
    expect(screen.getByText(/已丢弃 5 帧/)).toBeTruthy();
    expect(screen.getByText("丢帧").className).toContain("text-warning");
  });
});
