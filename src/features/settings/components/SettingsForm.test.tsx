// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

const nics = vi.hoisted(() => ({
  data: [
    { name: "全部接口", ip: "0.0.0.0", isLoopback: false },
    { name: "Ethernet", ip: "192.168.1.10", isLoopback: false },
  ],
}));

vi.mock("../hooks/useNetworkInterfaces", () => ({
  useNetworkInterfaces: () => ({ data: nics.data }),
}));

import { DEFAULT_SETTINGS } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { SettingsForm } from "./SettingsForm";

const withProtocol = (over: Partial<AppSettings["protocol"]>): AppSettings => ({
  ...DEFAULT_SETTINGS,
  protocol: { ...DEFAULT_SETTINGS.protocol, ...over },
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(() => cleanup());

describe("SettingsForm 的 sACN 开关", () => {
  it("默认配置里 sACN 是关闭的", () => {
    expect(DEFAULT_SETTINGS.protocol.sacnEnabled).toBe(false);
  });

  it("sACN 关闭时只保留开关本身，端口与 Universe 都隐藏", () => {
    render(<SettingsForm settings={withProtocol({ sacnEnabled: false })} update={vi.fn()} />);

    expect(screen.getByText("启用 sACN")).toBeTruthy();
    expect(screen.queryByText("sACN 端口")).toBeNull();
    expect(screen.queryByText(/sACN 接收 Universe/)).toBeNull();
    // Art-Net 的设置不受影响
    expect(screen.getByText("Art-Net 端口")).toBeTruthy();
  });

  it("sACN 开启时显示端口与 Universe", () => {
    render(<SettingsForm settings={withProtocol({ sacnEnabled: true })} update={vi.fn()} />);

    expect(screen.getByText("sACN 端口")).toBeTruthy();
    expect(screen.getByText(/sACN 接收 Universe/)).toBeTruthy();
  });

  it("拨动开关会把 sacnEnabled 写入草稿", () => {
    const update = vi.fn();
    const settings = withProtocol({ sacnEnabled: false });
    render(<SettingsForm settings={settings} update={update} />);

    const row = screen.getByText("启用 sACN").closest(".py-5")!;
    fireEvent.click(row.querySelector('[role="switch"]')!);

    const updater = update.mock.calls[0][0] as (s: AppSettings) => AppSettings;
    expect(updater(settings).protocol.sacnEnabled).toBe(true);
  });

  it("多网卡模式下，每块网卡的 sACN 开关只在总开关开启时出现", () => {
    const multi = (sacnEnabled: boolean): AppSettings => ({
      ...withProtocol({ sacnEnabled }),
      network: { mode: "multiNic", interface: "0.0.0.0", multiNic: [] },
    });

    const { rerender } = render(<SettingsForm settings={multi(false)} update={vi.fn()} />);
    expect(screen.getByText("Art-Net", { exact: true })).toBeTruthy();
    expect(screen.queryByText("sACN", { exact: true })).toBeNull();

    rerender(<SettingsForm settings={multi(true)} update={vi.fn()} />);
    expect(screen.getByText("sACN", { exact: true })).toBeTruthy();
  });

  it("端口被清空后离开输入框，回落到标准端口 5568（0 会让系统分配随机端口）", () => {
    const update = vi.fn();
    const settings = withProtocol({ sacnEnabled: true, sacnPort: 0 });
    const { container } = render(<SettingsForm settings={settings} update={update} />);

    // 页面里还有别的值为 0 的输入框，端口框靠 max=65535 区分
    fireEvent.blur(container.querySelector('input[max="65535"]')!);

    expect(update).toHaveBeenCalledTimes(1);
    const updater = update.mock.calls[0][0] as (s: AppSettings) => AppSettings;
    expect(updater(settings).protocol.sacnPort).toBe(5568);
  });

  it("端口合法时离开输入框不触发保存", () => {
    const update = vi.fn();
    render(
      <SettingsForm
        settings={withProtocol({ sacnEnabled: true, sacnPort: 5570 })}
        update={update}
      />,
    );

    fireEvent.blur(screen.getByDisplayValue("5570"));
    expect(update).not.toHaveBeenCalled();
  });

  it("Universe 输入只保留 sACN 合法范围 1~63999", () => {
    const update = vi.fn();
    const settings = withProtocol({ sacnEnabled: true, sacnUniverses: [1] });
    render(<SettingsForm settings={settings} update={update} />);

    const input = screen.getByDisplayValue("1");
    fireEvent.change(input, { target: { value: "0, 5, 64000, 5, 63999, 2" } });
    fireEvent.blur(input);

    const updater = update.mock.calls[0][0] as (s: AppSettings) => AppSettings;
    expect(updater(settings).protocol.sacnUniverses).toEqual([2, 5, 63999]);
  });
});
