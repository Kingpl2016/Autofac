// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { Device } from "@/shared/domain/device";

const forwarding = vi.hoisted(() => ({
  data: undefined as { destinations: { enabled: boolean }[] } | undefined,
}));

vi.mock("@/features/forwarding", () => ({ useForwardingQuery: () => forwarding }));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: false }),
  useSettingsQuery: () => ({ data: { merge: { mode: "htp" } } }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = async () => undefined;
    set = async () => undefined;
    delete = async () => undefined;
  },
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { DashboardView } from "../DashboardView";

const device = (ip: string, online: boolean): Device => ({
  ip,
  hostname: null,
  customName: null,
  mac: null,
  category: "artNet",
  artnetPorts: 4,
  online,
  lastSeenMs: 0,
});

/** 取统计卡的文本：统计卡在页面最上方，取第一个同名文字所在的容器。 */
function cardText(label: string): string {
  const el = screen.getAllByText(label)[0];
  return el.parentElement?.textContent ?? "";
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  forwarding.data = undefined;
  useEngineDataStore.setState({
    stats: {
      activeUniverses: 12,
      totalPackets: 1000,
      packetRate: 1234,
      uptimeSec: 200,
      memoryBytes: 84 * 1024 * 1024,
    },
    universes: [],
    devices: [],
  });
});
afterEach(() => cleanup());

describe("DashboardView 统计卡", () => {
  it("显示真实的包速率（带 pps 单位）与进程内存", () => {
    render(<DashboardView />);
    expect(cardText("包速率")).toContain("1.2k");
    expect(cardText("包速率")).toContain("pps");
    expect(cardText("进程内存")).toContain("84");
    expect(cardText("进程内存")).toContain("MB");
    expect(cardText("运行时长")).toContain("03:20");
  });

  it("设备数显示在线数，有离线设备时附带总数", () => {
    useEngineDataStore.setState({
      devices: [device("10.0.0.1", true), device("10.0.0.2", true), device("10.0.0.3", false)],
    });
    render(<DashboardView />);
    const text = cardText("发现设备");
    expect(text).toContain("2");
    expect(text).toContain("共 3 台");
  });

  it("全部在线时不重复显示总数提示", () => {
    useEngineDataStore.setState({ devices: [device("10.0.0.1", true)] });
    render(<DashboardView />);
    expect(cardText("发现设备")).not.toContain("共");
  });

  it("转发表未加载时目的地显示“—”，不把未知当成 0", () => {
    render(<DashboardView />);
    expect(cardText("转发目的地")).toContain("—");
  });

  it("转发表已加载时显示总数与已启用数", () => {
    forwarding.data = {
      destinations: [{ enabled: true }, { enabled: false }, { enabled: true }],
    };
    render(<DashboardView />);
    const text = cardText("转发目的地");
    expect(text).toContain("3");
    expect(text).toContain("已启用 2 个");
  });

  it("没有目的地时显示 0 且不显示启用提示", () => {
    forwarding.data = { destinations: [] };
    render(<DashboardView />);
    const text = cardText("转发目的地");
    expect(text).toContain("0");
    expect(text).not.toContain("已启用");
  });

  it("不再渲染集群占位卡", () => {
    render(<DashboardView />);
    expect(screen.queryByText("集群状态")).toBeNull();
  });
});