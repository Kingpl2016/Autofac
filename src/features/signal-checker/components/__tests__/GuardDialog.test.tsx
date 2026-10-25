// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import type { StartReason } from "../../lib/guard";
import { GuardDialog } from "../GuardDialog";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(() => cleanup());

const reasons: StartReason[] = [
  { kind: "remote", ip: "10.0.0.9" },
  { kind: "forwarding", count: 2 },
  { kind: "strobe" },
];

describe("GuardDialog", () => {
  it("reasons 为 null 时不显示", () => {
    render(<GuardDialog reasons={null} variant="start" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("开始发送前确认：逐条写出原因，默认聚焦“取消”", async () => {
    render(<GuardDialog reasons={reasons} variant="start" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "确认开始发送？" });
    expect(dialog.textContent).toContain("目标 10.0.0.9 不是本机：收到信号的灯具会真实响应这些测试信号");
    expect(dialog.textContent).toContain("转发表里有 2 个启用的目的地");
    expect(dialog.textContent).toContain("可能诱发光敏性癫痫");
    expect(dialog.querySelectorAll("li")).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" })));
  });

  it("切换到频闪时用另一套标题和按钮文案", async () => {
    render(
      <GuardDialog reasons={[{ kind: "strobe" }]} variant="switch" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await screen.findByRole("dialog", { name: "确认切换到频闪？" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仍然切换" })).toBeTruthy();
  });

  it("确认与取消各走各的回调；Esc 等同取消", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<GuardDialog reasons={reasons} variant="start" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(await screen.findByRole("button", { name: "仍然开始发送" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
