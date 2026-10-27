// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { EMPTY_STATUS, type RecordingStatus, type UniversePlan } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { RecordMonitor } from "../RecordMonitor";

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

const PLAN: UniversePlan = { accepted: [1, 2], rejectedOutOfRange: [], rejectedOverCapacity: [] };

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useRecordingStore.setState({ status: EMPTY_STATUS, last: null, activity: null });
});
afterEach(() => cleanup());

describe("RecordMonitor", () => {
  it("待机：预览将录制的 Universe 及其实时活动", () => {
    render(<RecordMonitor status={EMPTY_STATUS} snapshots={[snap(1, 256), snap(2, 0)]} plan={PLAN} />);
    expect(screen.getByRole("heading", { name: "录制预览" })).toBeTruthy();
    expect(screen.getByText("将录制 2 个 Universe")).toBeTruthy();
    expect(screen.getAllByTitle(/^Universe \d+：/).map((c) => c.getAttribute("title"))).toEqual([
      "Universe 1：256 个通道有输出",
      "Universe 2：0 个通道有输出",
    ]);
  });

  it("没有可录制的 Universe：徽标告警 + 空状态说明；被拒的 Universe 用文字列出", () => {
    render(
      <RecordMonitor
        status={EMPTY_STATUS}
        snapshots={[]}
        plan={{ accepted: [], rejectedOutOfRange: [2500], rejectedOverCapacity: [] }}
      />,
    );
    expect(screen.getByText("当前没有可录制的 Universe")).toBeTruthy();
    expect(screen.getByText(/当前没有可录制的 Universe。请让设备发送信号/)).toBeTruthy();
    expect(screen.getByText(/Universe 2500 超出 ArtRec 可表示范围（≤ 2047）/)).toBeTruthy();
  });

  it("录制中：显示已录 Universe 活动与被忽略的 Universe 告警", () => {
    const status: RecordingStatus = {
      ...EMPTY_STATUS,
      recording: true,
      universes: [3],
      stats: { ...EMPTY_STATUS.stats, ignoredUniverses: 2 },
    };
    render(<RecordMonitor status={status} snapshots={[snap(3, 10)]} plan={PLAN} />);
    expect(screen.getByRole("heading", { name: "已录 Universe 活动" })).toBeTruthy();
    expect(screen.getByText("1 个 Universe")).toBeTruthy();
    expect(screen.getByText(/有 2 个录制开始后才出现的 Universe 被忽略/)).toBeTruthy();
    expect(screen.queryByText(/Universe 集合在开始录制时确定/)).toBeNull();
  });
});
