// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

vi.mock("@/features/settings", () => ({ useProtocolFlags: () => ({ sacnEnabled: false }) }));

import { newDestination, type ForwardDestination } from "../../lib/types";
import { DestinationDialog } from "../DestinationDialog";

function setup(initial: ForwardDestination = newDestination()) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  render(<DestinationDialog open onOpenChange={onOpenChange} initial={initial} onSave={onSave} />);
  return { onSave, onOpenChange };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("DestinationDialog 校验", () => {
  it("提交前不显示任何错误", () => {
    setup();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("名称与 IP 为空：阻止保存，显示内联错误并把焦点移到第一个出错字段", () => {
    const { onSave, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("请填写名称")).toBeTruthy();
    expect(screen.getByText("请填写目标 IP")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("名称"));
    expect(screen.getByLabelText("名称").getAttribute("aria-invalid")).toBe("true");
  });

  it("IP 格式错误：显示具体原因，并通过 aria-describedby 关联", () => {
    setup();
    type("名称", "舞台左");
    type("目标 IP", "10.0.0");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const input = screen.getByLabelText("目标 IP");
    expect(screen.getByText(/目标 IP 格式不正确/)).toBeTruthy();
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain("IPv4");
  });

  it("提交后随修改实时更新：改对即消失，可以保存", () => {
    const { onSave, onOpenChange } = setup();
    type("名称", "  舞台左  ");
    type("目标 IP", "bad");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText(/目标 IP 格式不正确/)).toBeTruthy();

    type("目标 IP", " 10.0.0.5 ");
    expect(screen.queryByText(/目标 IP 格式不正确/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    // 保存时去掉名称与 IP 首尾空白
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: "舞台左", targetIp: "10.0.0.5" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("端口、偏移、延迟越界都会被拦下", () => {
    setup({ ...newDestination(), name: "A", targetIp: "10.0.0.5" });
    type("端口", "70000");
    type("Universe 偏移", "100000");
    type("默认延迟 (ms)", "5000");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("端口需为 1 到 65535 的整数")).toBeTruthy();
    expect(screen.getByText("偏移需为整数，范围 -65535 到 65535")).toBeTruthy();
    expect(screen.getByText("延迟需为 0 到 2000 的整数（毫秒）")).toBeTruthy();
  });

  it("覆盖规则出错时在该行下方提示", () => {
    setup({
      ...newDestination(),
      name: "A",
      targetIp: "10.0.0.5",
      overrides: [{ sourceUniverse: 70000, action: "forward", targetUniverse: null, delayMs: null }],
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("源 Universe 需为 0 到 65535 的整数")).toBeTruthy();
    expect(screen.getByLabelText("源 Universe").getAttribute("aria-invalid")).toBe("true");
  });

  it("取消不会触发保存", () => {
    const { onSave, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});