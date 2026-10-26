// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { OutputPayload } from "@/shared/domain/engine";
import { newDestination, type ForwardDestination } from "../../lib/types";
import { DestinationStats } from "../DestinationStats";

const dest = (over: Partial<ForwardDestination> = {}): ForwardDestination => ({
  ...newDestination(),
  id: "a",
  name: "A",
  targetIp: "10.0.0.5",
  ...over,
});

const output = (destinations: OutputPayload["destinations"]): OutputPayload => ({
  state: "sending",
  sent: 0,
  sendErrors: 0,
  dropped: 0,
  sentRate: 0,
  lastError: null,
  lastErrorAgoMs: null,
  sender: "ready",
  destinations,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("DestinationStats", () => {
  it("已停用的目的地显示“已停用”，而不是 0", () => {
    render(
      <DestinationStats
        dest={dest({ enabled: false })}
        output={output([{ id: "a", sent: 5, errors: 0, dropped: 0, sentRate: 1, lastSendAgoMs: 0 }])}
        receivedAt={0}
        now={0}
      />,
    );
    expect(screen.getByText("已停用，不发送数据")).toBeTruthy();
    expect(screen.queryByText("已发送")).toBeNull();
  });

  it("还没收到统计事件时显示等待", () => {
    render(<DestinationStats dest={dest()} output={null} receivedAt={null} now={0} />);
    expect(screen.getByText("等待统计数据")).toBeTruthy();
  });

  it("启用但没有任何记录时显示“尚未发送数据”", () => {
    render(<DestinationStats dest={dest()} output={output([])} receivedAt={0} now={0} />);
    expect(screen.getByText("尚未发送数据")).toBeTruthy();
  });

  it("显示累计、速率、丢帧、错误与补偿后的最近发送时间", () => {
    render(
      <DestinationStats
        dest={dest()}
        output={output([
          { id: "a", sent: 12340, errors: 2, dropped: 7, sentRate: 1234, lastSendAgoMs: 500 },
          { id: "other", sent: 1, errors: 0, dropped: 0, sentRate: 0, lastSendAgoMs: 0 },
        ])}
        receivedAt={1000}
        now={3500}
      />,
    );
    expect(screen.getByText("12,340 · 1.2k pps")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    const errors = screen.getByText("2");
    expect(errors.className).toContain("text-destructive");
    // 500ms + (3500 - 1000)ms = 3.0s
    expect(screen.getByText("3.0s前")).toBeTruthy();
    expect(screen.queryByText("统计已过期")).toBeNull();
  });

  it("速率为 0 时不显示速率；从未成功发送时最近发送为“—”", () => {
    render(
      <DestinationStats
        dest={dest()}
        output={output([{ id: "a", sent: 0, errors: 3, dropped: 0, sentRate: 0, lastSendAgoMs: null }])}
        receivedAt={0}
        now={0}
      />,
    );
    expect(screen.queryByText(/pps/)).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("超过 5 秒没有新统计时标记过期", () => {
    render(
      <DestinationStats
        dest={dest()}
        output={output([{ id: "a", sent: 1, errors: 0, dropped: 0, sentRate: 1, lastSendAgoMs: 0 }])}
        receivedAt={0}
        now={6000}
      />,
    );
    expect(screen.getByText("统计已过期")).toBeTruthy();
  });
});