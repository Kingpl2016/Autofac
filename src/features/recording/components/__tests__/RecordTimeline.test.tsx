// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { decodeActivity } from "../../lib/recordTimeline";
import { EMPTY_STATUS, type ActivityDto, type RecordingStatus } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { RecordTimeline } from "../RecordTimeline";

const WIDTH = 600;
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => WIDTH,
  });
});
afterAll(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
});

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const activity = (over: Partial<ActivityDto> = {}) =>
  decodeActivity({
    generation: 0,
    bucketUs: 250_000,
    len: 4,
    from: 0,
    universes: [1, 2],
    change: [b64([10, 0, 0, 30]), b64([0, 0, 0, 0])],
    level: [b64([200, 200, 200, 255]), b64([0, 0, 0, 0])],
    partStartsUs: [0],
    ...over,
  });

const live = (over: Partial<RecordingStatus> = {}): RecordingStatus => ({
  ...EMPTY_STATUS,
  recording: true,
  path: "D:\\rec\\a.artrec",
  part: 1,
  elapsedUs: 30_000_000,
  sessionElapsedUs: 30_000_000,
  partStartsUs: [0],
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useRecordingStore.setState({ status: EMPTY_STATUS, activity: null, last: null, statusAt: performance.now() });
});
afterEach(() => cleanup());

describe("RecordTimeline", () => {
  it("没在录制、也没有上一次录制时不渲染", () => {
    const { container } = render(<RecordTimeline />);
    expect(container.innerHTML).toBe("");
  });

  it("录制中：录制头按已录时长在 1 分钟轴上定位，并给出文字替代", () => {
    useRecordingStore.setState({ status: live(), activity: activity() });
    render(<RecordTimeline />);
    const head = screen.getByTestId("record-head");
    // 30 秒 / 60 秒轴 × 600px = 300px
    expect(head.style.transform).toBe("translateX(300px)");
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toContain("0:30.0");
    expect(img.getAttribute("aria-label")).toContain("2 个 Universe");
    // 读屏摘要：每路一行
    expect(screen.getByText("各 Universe 活动摘要")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("分段边界画竖线，数量为分段数 - 1；超过 1 分钟后时间轴扩到 5 分钟", () => {
    useRecordingStore.setState({
      status: live({ part: 3, sessionElapsedUs: 150_000_000, partStartsUs: [0, 60_000_000, 120_000_000] }),
      activity: activity({ partStartsUs: [0, 60_000_000, 120_000_000] }),
    });
    render(<RecordTimeline />);
    const lines = screen.getAllByTestId("record-part-line");
    expect(lines).toHaveLength(2);
    // 60 秒 / 300 秒轴 × 600px = 120px
    expect(lines[0].style.transform).toBe("translateX(120px)");
    expect(screen.getByText("时间轴 5:00.0")).toBeTruthy();
  });

  it("停止后保留上一次录制的时间线，录制头停在数据末端", () => {
    useRecordingStore.setState({
      status: EMPTY_STATUS,
      activity: activity({ len: 40 }),
      last: { files: [], error: null, dropped: 0, stoppedBy: null },
    });
    render(<RecordTimeline />);
    // 40 × 0.25s = 10s / 60s × 600px = 100px
    expect(screen.getByTestId("record-head").style.transform).toBe("translateX(100px)");
  });
});
