import { describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  register: vi.fn(
    (_accelerator: string, _handler: (e: { state: string }) => void) =>
      Promise.resolve(),
  ),
  unregister: vi.fn((_accelerator: string) => Promise.resolve()),
  isRegistered: vi.fn((_accelerator: string) => Promise.resolve(true)),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => plugin);

import {
  registerShortcut,
  unregisterShortcut,
  isShortcutRegistered,
} from "../globalShortcut";

describe("registerShortcut", () => {
  it("用加速键注册，且仅在按下时触发回调", async () => {
    const onPressed = vi.fn();
    await registerShortcut("CommandOrControl+Shift+R", onPressed);

    expect(plugin.register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+R",
      expect.any(Function),
    );
    const handler = plugin.register.mock.calls[0][1];

    handler({ state: "Released" });
    expect(onPressed).not.toHaveBeenCalled();
    handler({ state: "Pressed" });
    expect(onPressed).toHaveBeenCalledTimes(1);
  });
});

describe("unregisterShortcut / isShortcutRegistered", () => {
  it("透传到插件", async () => {
    await unregisterShortcut("F5");
    expect(plugin.unregister).toHaveBeenCalledWith("F5");

    await expect(isShortcutRegistered("F5")).resolves.toBe(true);
    expect(plugin.isRegistered).toHaveBeenCalledWith("F5");
  });
});
