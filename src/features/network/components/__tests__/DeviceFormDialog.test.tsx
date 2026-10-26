// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ netdevProbe: vi.fn(), netdevStatus: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), ...api }));

import { DeviceFormDialog } from "../DeviceFormDialog";

function setup(props: Partial<React.ComponentProps<typeof DeviceFormDialog>> = {}) {
  const onSave = vi.fn().mockResolvedValue({ id: "new-id" });
  const onSetToken = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(
    <DeviceFormDialog open onOpenChange={onOpenChange} onSave={onSave} onSetToken={onSetToken} {...props} />,
  );
  return { onSave, onSetToken, onOpenChange };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("DeviceFormDialog", () => {
  it("关闭时不渲染", () => {
    render(<DeviceFormDialog open={false} onOpenChange={vi.fn()} onSave={vi.fn()} onSetToken={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("提交空表单时给出字段内联错误，且不保存", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("请输入主机或 IP")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("主机 / IP").getAttribute("aria-invalid")).toBe("true");
  });

  it("拒绝带协议的主机与越界端口", async () => {
    const { onSave } = setup();
    type("主机 / IP", "http://10.0.0.2");
    type("端口", "70000");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/不要带 http:\/\/、端口或路径/, { selector: "[role=alert]" })).toBeTruthy();
    expect(screen.getByText("端口必须在 1~65535 之间")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存新设备：名称留空由后端用主机代替，Token 单独写入凭据", async () => {
    const { onSave, onSetToken, onOpenChange } = setup();
    type("主机 / IP", " 10.0.0.2 ");
    type("Token（可选）", "abcd1234");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ id: undefined, name: "", host: "10.0.0.2", port: 80 }));
    await waitFor(() => expect(onSetToken).toHaveBeenCalledWith("new-id", "abcd1234"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("没填 Token 时不写凭据；Token 格式不对时不保存", async () => {
    const { onSave, onSetToken } = setup();
    type("主机 / IP", "10.0.0.2");
    type("Token（可选）", "short");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("Token 须为 8~64 位可见字符")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    type("Token（可选）", "");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSetToken).not.toHaveBeenCalled();
  });

  it("测试连接：成功显示版本，401 提示需要 Token 但仍可保存", async () => {
    api.netdevProbe.mockResolvedValueOnce({ version: "1.4.2" });
    setup();
    type("主机 / IP", "10.0.0.2");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功：固件 1.4.2")).toBeTruthy();
    expect(api.netdevProbe).toHaveBeenCalledWith("10.0.0.2", 80, undefined);

    api.netdevProbe.mockRejectedValueOnce({ code: "unauthorized", message: "x" });
    type("端口", "81");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/设备需要 Token/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("编辑已有设备：Token 留空时用已保存的 Token 测试，并能清除 Token", async () => {
    api.netdevStatus.mockResolvedValue({ version: "1.3.0" });
    const device = { id: "d1", name: "主舞台", host: "10.0.0.2", port: 80, hasToken: true };
    const { onSetToken, onOpenChange } = setup({ device });
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("主舞台");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功：固件 1.3.0")).toBeTruthy();
    expect(api.netdevStatus).toHaveBeenCalledWith("d1");
    expect(api.netdevProbe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "清除已保存的 Token" }));
    await waitFor(() => expect(onSetToken).toHaveBeenCalledWith("d1", ""));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("保存失败时在对话框里显示原因并保持打开", async () => {
    const onSave = vi.fn().mockRejectedValue({ code: "invalid", message: "该主机和端口已添加过" });
    const { onOpenChange } = setup({ onSave });
    type("主机 / IP", "10.0.0.2");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/该主机和端口已添加过/)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("显示 / 隐藏 Token", () => {
    setup();
    const input = screen.getByLabelText("Token（可选）") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "显示 Token" }));
    expect(input.type).toBe("text");
  });

  it("使用设备发现的预填值", () => {
    setup({ draft: { name: "ANS-NODE-07", host: "192.168.1.77", port: 80 } });
    expect((screen.getByLabelText("主机 / IP") as HTMLInputElement).value).toBe("192.168.1.77");
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("ANS-NODE-07");
  });
});
