// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

vi.mock("@/features/settings", () => ({ useProtocolFlags: () => ({ sacnEnabled: true, artnetEnabled: true }) }));

import { PlayerTargetPicker } from "../PlayerTargetPicker";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(() => cleanup());

describe("PlayerTargetPicker", () => {
  it("0.0.0.0 不能应用为发送目标，并说明原因", () => {
    const onApply = vi.fn();
    render(<PlayerTargetPicker target={{ kind: "direct", ip: "192.168.1.50", protocol: "artNet", port: 6454 }} destinations={0} onApply={onApply} />);
    const ip = screen.getByLabelText("设备 IP");
    fireEvent.change(ip, { target: { value: "0.0.0.0" } });
    expect(ip.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/0\.0\.0\.0 不能作为发送目标/)).toBeTruthy();
    const apply = screen.getByRole("button", { name: "应用" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(ip, { target: { value: "255.255.255.255" } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({ kind: "direct", ip: "255.255.255.255", protocol: "artNet", port: 6454 });
  });

  it("已保存的目标是 0.0.0.0 时直接给出警告", () => {
    render(<PlayerTargetPicker target={{ kind: "direct", ip: "0.0.0.0", protocol: "artNet", port: 6454 }} destinations={0} onApply={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("当前目标是 0.0.0.0");
  });
});
