// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { AccessState } from "../../lib/access";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { AccessBanner } from "../AccessBanner";

function make(state: AccessState, over: Partial<DeviceAccess> = {}): DeviceAccess {
  return {
    state,
    canRead: state === "ok",
    canWrite: state === "ok",
    status: { status: null, online: false, error: null, isLoading: false, refetch: vi.fn() },
    tokenSet: null,
    markRebooting: vi.fn(),
    ...over,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("AccessBanner", () => {
  it.each<AccessState>(["ok", "none", "checking"])("%s 状态不显示横幅", (state) => {
    const { container } = render(<AccessBanner access={make(state)} onEditDevice={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("需要 Token：说明原因，按钮直接打开编辑", () => {
    const onEdit = vi.fn();
    render(<AccessBanner access={make("needToken")} onEditDevice={onEdit} />);
    expect(screen.getByRole("alert").textContent).toContain("设备要求 Token");
    fireEvent.click(screen.getByRole("button", { name: "设置 Token" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("离线：显示具体错误并可重试；用礼貌的 status 播报，不用 alert 打断", () => {
    const refetch = vi.fn();
    const access = make("offline", {
      status: { status: null, online: false, error: { code: "timeout", message: "x" }, isLoading: false, refetch },
    });
    render(<AccessBanner access={access} onEditDevice={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("请求超时");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("重启中是 status 而不是 alert", () => {
    render(<AccessBanner access={make("rebooting")} onEditDevice={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("设备重启中");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("设备未配置 Token 时默认可写，不显示只读横幅", () => {
    const { container } = render(<AccessBanner access={make("ok", { tokenSet: false })} onEditDevice={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
