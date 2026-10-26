// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { FlowList } from "../../lib/listModel";
import { FlowListView } from "../FlowListView";

const list = (over: Partial<FlowList> = {}): FlowList => ({
  rows: [
    {
      universe: 1,
      active: true,
      packetRate: 88,
      activeChannels: 300,
      conflict: "warning",
      conflictChannels: 6,
      protocol: "sacn",
      sources: [
        { ip: "10.0.0.2", isPlayer: false, packetRate: 44, active: true },
        { ip: "10.0.0.10", isPlayer: false, packetRate: 0, active: false },
      ],
      destinations: [
        { id: "a", name: "舞台左", enabled: true, active: true },
        { id: "b", name: "备用", enabled: false, active: false },
      ],
    },
    {
      universe: 2,
      active: false,
      packetRate: 0,
      activeChannels: 0,
      conflict: "none",
      conflictChannels: 0,
      protocol: "artNet",
      sources: [{ ip: "__player__", isPlayer: true, packetRate: 0, active: false }],
      destinations: [],
    },
  ],
  sources: [],
  destinations: [
    {
      id: "a", name: "舞台左", ip: "10.0.1.1", port: 6454, protocol: "artNet", mode: "selected",
      enabled: true, universeOffset: 100, delayMs: 30, sentRate: 1234, active: true, universeCount: 1,
    },
    {
      id: "b", name: "备用", ip: "10.0.1.2", port: 5568, protocol: "sacn", mode: "all",
      enabled: false, universeOffset: -5, delayMs: 0, sentRate: 0, active: false, universeCount: 2,
    },
  ],
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("FlowListView Universe 路径表", () => {
  it("有表格标题和列头，行头是 Universe", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="开场秀" />);
    const table = screen.getByRole("table", { name: "来源、Universe 与目的地的对应关系" });
    for (const h of ["状态", "Universe", "来源", "包速率", "活跃通道", "目的地"]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeTruthy();
    }
    expect(within(table).getByRole("rowheader", { name: /Universe 1/ })).toBeTruthy();
  });

  it("状态用文字表达：有信号 / 无信号", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const table = screen.getByRole("table", { name: /对应关系/ });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("有信号")).toBeTruthy();
    expect(within(rows[2]).getByText("无信号", { selector: "span.inline-flex" })).toBeTruthy();
  });

  it("多来源时每个来源带速率，无信号的来源有文字标注", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const row = within(screen.getByRole("table", { name: /对应关系/ })).getAllByRole("row")[1];
    expect(within(row).getByText("10.0.0.2")).toBeTruthy();
    expect(within(row).getByText("44 pps")).toBeTruthy();
    expect(within(row).getByText("10.0.0.10")).toBeTruthy();
  });

  it("回放伪源显示节目名；没有节目名时显示“回放”", () => {
    const { unmount } = render(<FlowListView list={list()} showProtocol={false} playerName="开场秀" />);
    expect(screen.getByText("开场秀")).toBeTruthy();
    unmount();
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    expect(screen.getByText("回放")).toBeTruthy();
  });

  it("目的地列：停用的带 OFF 标签；没有去向显示占位符", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const rows = within(screen.getByRole("table", { name: /对应关系/ })).getAllByRole("row");
    expect(within(rows[1]).getByText("OFF")).toBeTruthy();
    expect(within(rows[2]).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("冲突徽标带级别；协议仅在 sACN 开启时显示", () => {
    const { unmount } = render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    expect(screen.getByText(/6 个冲突通道/).className).toContain("bg-warning");
    expect(screen.queryByText("sACN")).toBeNull();
    unmount();
    render(<FlowListView list={list()} showProtocol playerName="" />);
    const paths = within(screen.getByRole("table", { name: /对应关系/ }));
    expect(paths.getByText("sACN")).toBeTruthy();
  });
});

describe("FlowListView 目的地表", () => {
  const table = () => screen.getByRole("table", { name: "转发目的地及其发送情况" });

  it("显示地址、模式、偏移（带正负号）、延迟、发送速率与 Universe 数", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const row = within(table()).getAllByRole("row")[1];
    expect(row.textContent).toContain("10.0.1.1:6454");
    expect(row.textContent).toContain("仅选定");
    expect(row.textContent).toContain("+100");
    expect(row.textContent).toContain("30ms");
    expect(row.textContent).toContain("1.2k pps");
  });

  it("停用的目的地：状态为已停用，不显示发送速率，负偏移带负号", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const row = within(table()).getAllByRole("row")[2];
    expect(within(row).getByText("已停用")).toBeTruthy();
    expect(row.textContent).toContain("-5");
    expect(row.textContent).not.toContain("pps");
  });

  it("sACN 开启时地址前带协议", () => {
    render(<FlowListView list={list()} showProtocol playerName="" />);
    const row = within(table()).getAllByRole("row")[2];
    expect(row.textContent).toContain("sACN");
  });
});

describe("FlowListView 空状态与可访问性", () => {
  it("没有 Universe / 目的地时各自显示说明，而不是空表", () => {
    render(
      <FlowListView list={{ rows: [], sources: [], destinations: [] }} showProtocol={false} playerName="" />,
    );
    expect(screen.getByText("暂无活跃 Universe")).toBeTruthy();
    expect(screen.getByText("暂无转发目的地，点击右上角添加")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("长表格的滚动容器可聚焦，并有可访问名称", () => {
    render(<FlowListView list={list()} showProtocol={false} playerName="" />);
    const region = screen.getByRole("region", { name: "Universe 路径" });
    expect(region.tabIndex).toBe(0);
  });
});