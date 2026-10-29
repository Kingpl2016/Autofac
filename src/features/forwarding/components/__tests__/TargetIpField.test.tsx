// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { Device } from "@/shared/domain/device";
import { makeDevice } from "@/test/factories";

const flags = vi.hoisted(() => ({ sacnEnabled: false }));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { newDestination } from "../../lib/types";
import { DestinationDialog } from "../DestinationDialog";

const dev = (ip: string, over: Partial<Device> = {}): Device => makeDevice({ ip, ...over });

beforeAll(() => {
  // Radix Select 在 jsdom 里需要这几个浏览器 API
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  flags.sacnEnabled = false;
  useEngineDataStore.setState({
    devices: [
      dev("10.0.0.5", { customName: "舞台左" }),
      dev("10.0.0.6", { hostname: "node-6" }),
      dev("10.0.0.7", { category: "computer", hostname: "控台" }),
      dev("10.0.0.8", { online: false, customName: "离线灯" }),
    ],
  });
});
afterEach(() => cleanup());

function setup(initial = newDestination()) {
  const onSave = vi.fn();
  render(<DestinationDialog open onOpenChange={vi.fn()} initial={initial} onSave={onSave} />);
  return { onSave };
}

function openSelect() {
  const trigger = screen.getByRole("combobox", { name: "目标 IP" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return trigger;
}

describe("目标 IP 设备选择器", () => {
  it("有在线设备且 IP 为空时默认显示下拉；分组列出在线设备，不含离线设备", () => {
    setup();
    openSelect();
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("Art-Net 节点")).toBeTruthy();
    expect(within(listbox).getByText("其他设备")).toBeTruthy();
    expect(within(listbox).queryByText("sACN 节点")).toBeNull();
    expect(within(listbox).getByText("舞台左")).toBeTruthy();
    expect(within(listbox).getByText("控台")).toBeTruthy();
    expect(within(listbox).queryByText("离线灯")).toBeNull();
    expect(within(listbox).getByText("手动输入 IP…")).toBeTruthy();
  });

  it("选中设备：填入 IP，名称为空时自动填名称", () => {
    setup();
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: /舞台左/ }));

    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("舞台左");
    expect(screen.getByRole("combobox", { name: "目标 IP" }).textContent).toContain("10.0.0.5");
  });

  it("已填名称时选设备不会覆盖名称", () => {
    setup();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "我的名字" } });
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: /舞台左/ }));
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("我的名字");
  });

  it("下拉里的“手动输入 IP…”切到输入框，并可用按钮切回", () => {
    setup();
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: "手动输入 IP…" }));

    const input = screen.getByLabelText("目标 IP") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "192.168.9.9" } });
    expect(input.value).toBe("192.168.9.9");

    fireEvent.click(screen.getByRole("button", { name: "从列表选择" }));
    expect(screen.getByRole("combobox", { name: "目标 IP" })).toBeTruthy();
  });

  it("编辑一个 IP 不在在线设备里的目的地：默认进入手动输入", () => {
    setup({ ...newDestination(), name: "旧灯", targetIp: "172.16.0.9" });
    const input = screen.getByLabelText("目标 IP") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("172.16.0.9");
  });

  it("编辑一个 IP 在在线设备里的目的地：显示下拉并带出当前设备", () => {
    setup({ ...newDestination(), name: "灯", targetIp: "10.0.0.6" });
    expect(screen.getByRole("combobox", { name: "目标 IP" }).textContent).toContain("node-6");
  });

  it("没有任何在线设备时只有输入框，也没有切换按钮", () => {
    useEngineDataStore.setState({ devices: [] });
    setup();
    expect((screen.getByLabelText("目标 IP") as HTMLInputElement).tagName).toBe("INPUT");
    expect(screen.queryByRole("button", { name: "从列表选择" })).toBeNull();
    expect(screen.queryByRole("button", { name: "手动输入" })).toBeNull();
  });

  it("sACN 开启后列出 sACN 节点，选中后协议与端口随之切换", () => {
    flags.sacnEnabled = true;
    useEngineDataStore.setState({
      devices: [dev("10.0.0.20", { category: "sacn", hostname: "sacn-灯" })],
    });
    setup();
    openSelect();
    expect(within(screen.getByRole("listbox")).getByText("sACN 节点")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /sacn-灯/ }));

    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("5568");
  });

  it("选完设备保存：IP、名称、端口都进入保存的数据", () => {
    const { onSave } = setup();
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: /舞台左/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "舞台左",
      targetIp: "10.0.0.5",
      protocol: "artNet",
      port: 6454,
    });
  });
});