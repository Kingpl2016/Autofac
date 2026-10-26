// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { OutputPayload } from "@/shared/domain/engine";
import { OutputHealthView } from "../OutputHealthStrip";

const base: OutputPayload = {
  state: "sending",
  sent: 12340,
  sendErrors: 0,
  dropped: 0,
  sentRate: 1234,
  lastError: null,
  lastErrorAgoMs: null,
  sender: "ready",
  destinations: [],
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("OutputHealthView", () => {
  it("尚未收到数据时显示等待", () => {
    render(<OutputHealthView output={null} receivedAt={null} now={0} />);
    expect(screen.getByText("等待引擎数据")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("显示状态与会话累计", () => {
    render(<OutputHealthView output={base} receivedAt={1000} now={2000} />);
    expect(screen.getByRole("status").textContent).toContain("发送中");
    expect(screen.getByText("12,340")).toBeTruthy();
    expect(screen.getByText("1.2k pps")).toBeTruthy();
    expect(screen.getByText("无")).toBeTruthy();
    expect(screen.queryByText("数据过期")).toBeNull();
  });

  it("超过 5 秒没有新数据时显示过期徽标", () => {
    render(<OutputHealthView output={base} receivedAt={1000} now={6000} />);
    expect(screen.getByText("数据过期")).toBeTruthy();
  });

  it("有错误时显示错误文本与补偿后的时长", () => {
    render(
      <OutputHealthView
        output={{
          ...base,
          state: "error",
          sendErrors: 3,
          lastError: "网络不可达",
          lastErrorAgoMs: 500,
        }}
        receivedAt={1000}
        now={3500}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("发送错误");
    expect(screen.getByText("网络不可达")).toBeTruthy();
    // 500ms + (3500 - 1000)ms = 3.0s
    expect(screen.getByText("3.0s前")).toBeTruthy();
  });

  it("发送器非就绪时提示状态", () => {
    render(
      <OutputHealthView
        output={{ ...base, state: "error", sender: "reconnecting" }}
        receivedAt={1000}
        now={1000}
      />,
    );
    expect(screen.getByText("发送器重连中")).toBeTruthy();
  });

  it("丢帧状态使用丢帧文案", () => {
    render(
      <OutputHealthView
        output={{ ...base, state: "dropping", dropped: 77 }}
        receivedAt={1000}
        now={1000}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("丢帧");
    expect(screen.getByText("77")).toBeTruthy();
  });
});