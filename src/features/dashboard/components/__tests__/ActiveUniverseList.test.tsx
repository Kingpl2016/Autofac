// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const settings = vi.hoisted(() => ({ sacn: false, mode: "htp" as "htp" | "ltp" | "priority" }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = async () => undefined;
    set = async () => undefined;
    delete = async () => undefined;
  },
}));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: settings.sacn }),
  useSettingsQuery: () => ({ data: { merge: { mode: settings.mode } } }),
}));

import i18n from "@/shared/i18n";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { DEFAULT_DASHBOARD_PREFS, useDashboardPrefs } from "../../stores/useDashboardPrefs";
import { ActiveUniverseList } from "../ActiveUniverseList";

const snap = (universe: number, over: Partial<UniverseSnapshot> = {}): UniverseSnapshot => ({
  universe,
  protocol: "artNet",
  sourceIps: ["192.168.1.20"],
  sourceCount: 1,
  activeChannels: 512,
  conflictChannels: 0,
  totalPackets: 12340,
  packetRate: 44,
  sources: [{ ip: "192.168.1.20", packets: 12340, packetRate: 44 }],
  ...over,
});

const many = (n: number) => Array.from({ length: n }, (_, i) => snap(i + 1));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  settings.sacn = false;
  settings.mode = "htp";
  useDashboardPrefs.setState({ ...DEFAULT_DASHBOARD_PREFS });
  useEngineDataStore.setState({ universes: [] });
});
afterEach(() => cleanup());

describe("ActiveUniverseList", () => {
  it("没有活动宇宙时显示空状态", () => {
    render(<ActiveUniverseList />);
    expect(screen.getByText("暂无活跃 Universe")).toBeTruthy();
  });

  it("卡片显示编号、Port-Address、速率与活跃通道", () => {
    useEngineDataStore.setState({ universes: [snap(1)] });
    render(<ActiveUniverseList />);
    expect(screen.getByText("Universe 1")).toBeTruthy();
    expect(screen.getByText("0:0:1")).toBeTruthy();
    expect(screen.getByText("512 活跃通道")).toBeTruthy();
    expect(screen.getByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText("44")).toBeTruthy();
  });

  it("多来源时显示合并模式与逐源速率，HTP 下冲突只是提示级", () => {
    useEngineDataStore.setState({
      universes: [
        snap(2, {
          sourceCount: 2,
          conflictChannels: 12,
          sources: [
            { ip: "10.0.0.10", packets: 1, packetRate: 30 },
            { ip: "10.0.0.2", packets: 1, packetRate: 14 },
          ],
        }),
      ],
    });
    render(<ActiveUniverseList />);
    expect(screen.getByText("HTP")).toBeTruthy();
    const badge = screen.getByText(/12 个冲突通道/);
    expect(badge.className).not.toContain("bg-warning");
    // 来源按 IP 数值排序，且各自带速率
    const rows = screen.getAllByText(/^10\.0\.0\./).map((el) => el.textContent);
    expect(rows).toEqual(["10.0.0.2", "10.0.0.10"]);
    expect(screen.getByText("30 pps")).toBeTruthy();
    expect(screen.getByText("14 pps")).toBeTruthy();
  });

  it("LTP 下同样的冲突升级为警告级", () => {
    settings.mode = "ltp";
    useEngineDataStore.setState({
      universes: [snap(2, { sourceCount: 2, conflictChannels: 3 })],
    });
    render(<ActiveUniverseList />);
    expect(screen.getByText("LTP")).toBeTruthy();
    expect(screen.getByText(/3 个冲突通道/).className).toContain("bg-warning");
  });

  it("单来源且无冲突时不显示合并或冲突徽标", () => {
    useEngineDataStore.setState({ universes: [snap(1)] });
    render(<ActiveUniverseList />);
    expect(screen.queryByText("HTP")).toBeNull();
    expect(screen.queryByText(/冲突通道/)).toBeNull();
  });

  it("来源过多时折叠为“另有 N 个来源”", () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({
      ip: `10.0.0.${i + 1}`,
      packets: 1,
      packetRate: 1,
    }));
    useEngineDataStore.setState({ universes: [snap(1, { sourceCount: 6, sources })] });
    render(<ActiveUniverseList />);
    expect(screen.getByText("另有 2 个来源")).toBeTruthy();
  });

  it("仅在 sACN 启用时显示协议徽标", () => {
    useEngineDataStore.setState({
      universes: [snap(1), snap(2, { protocol: "sacn" })],
    });
    const { unmount } = render(<ActiveUniverseList />);
    expect(screen.queryByText("sACN")).toBeNull();
    expect(screen.queryByText("Art-Net")).toBeNull();
    unmount();

    settings.sacn = true;
    render(<ActiveUniverseList />);
    expect(screen.getByText("sACN")).toBeTruthy();
    expect(screen.getByText("Art-Net")).toBeTruthy();
  });

  it("卡片视图超过 60 个时截取并提示切换到表格", () => {
    useEngineDataStore.setState({ universes: many(70) });
    render(<ActiveUniverseList />);
    expect(screen.getAllByText(/^Universe \d+$/)).toHaveLength(60);
    expect(screen.getByRole("note").textContent).toContain("仅显示前 60 个，共 70 个");
  });

  it("切换到表格后显示全部行，并保存选择", () => {
    useEngineDataStore.setState({ universes: many(70) });
    render(<ActiveUniverseList />);
    fireEvent.click(screen.getByRole("radio", { name: "表格" }));

    const table = screen.getByRole("table");
    // 表头一行 + 70 行数据
    expect(within(table).getAllByRole("row")).toHaveLength(71);
    expect(screen.queryByRole("note")).toBeNull();
    expect(useDashboardPrefs.getState().universeView).toBe("table");
  });

  it("表格里的包速率列显示 pps，累计包数带千分位", () => {
    useDashboardPrefs.setState({ universeView: "table" });
    useEngineDataStore.setState({ universes: [snap(5)] });
    render(<ActiveUniverseList />);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(row.textContent).toContain("44 pps");
    expect(row.textContent).toContain("12,340");
  });
});