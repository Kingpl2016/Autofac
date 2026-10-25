// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import type { TargetGroups } from "../../lib/types";
import { renderWithQuery } from "../../__tests__/helpers";
import { TargetPicker } from "../TargetPicker";

const groups: TargetGroups = {
  local: [{ ip: "127.0.0.1", name: null, online: null }],
  interfaces: [{ ip: "192.168.1.10", name: "Ethernet", online: null }],
  devices: [
    { ip: "192.168.1.50", name: "舞台灯", online: true },
    { ip: "192.168.1.60", name: null, online: false },
  ],
  broadcasts: [
    { ip: "192.168.1.255", name: null, online: null },
    { ip: "255.255.255.255", name: null, online: null },
  ],
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  invoke.mockResolvedValue(groups);
});

afterEach(() => cleanup());

const open = () => fireEvent.click(screen.getByRole("button", { name: "选择目标" }));

describe("TargetPicker", () => {
  it("展开前不向后端取列表；展开后按分组列出候选项", async () => {
    renderWithQuery(<TargetPicker onSelect={() => undefined} />);
    expect(invoke).not.toHaveBeenCalled();

    open();
    expect(await screen.findByRole("region", { name: "本机回环" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("signal_checker_targets");
    for (const name of ["本机网卡", "已发现设备", "广播地址"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    expect(screen.getByText("192.168.1.10")).toBeTruthy();
    expect(screen.getByText("Ethernet")).toBeTruthy();
    expect(screen.getByText("舞台灯")).toBeTruthy();
    expect(screen.getByText("受限广播（全部网卡）")).toBeTruthy();
    expect(screen.getByText("子网广播")).toBeTruthy();
  });

  it("离线设备用文字徽章标明，而不只靠颜色", async () => {
    renderWithQuery(<TargetPicker onSelect={() => undefined} />);
    open();
    await screen.findByText("192.168.1.60");
    expect(screen.getAllByText("离线")).toHaveLength(1);
  });

  it("选中某项：把 IP 交给父组件并收起", async () => {
    const onSelect = vi.fn();
    renderWithQuery(<TargetPicker onSelect={onSelect} />);
    open();
    fireEvent.click(await screen.findByText("192.168.1.50"));
    expect(onSelect).toHaveBeenCalledWith("192.168.1.50");
    await waitFor(() => expect(screen.queryByRole("region", { name: "本机回环" })).toBeNull());
  });

  it("空分组不显示", async () => {
    invoke.mockResolvedValue({ ...groups, devices: [], interfaces: [] });
    renderWithQuery(<TargetPicker onSelect={() => undefined} />);
    open();
    await screen.findByRole("region", { name: "本机回环" });
    expect(screen.queryByRole("region", { name: "已发现设备" })).toBeNull();
    expect(screen.queryByRole("region", { name: "本机网卡" })).toBeNull();
  });
});
