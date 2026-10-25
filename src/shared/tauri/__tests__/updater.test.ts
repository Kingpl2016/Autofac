import { describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock("@tauri-apps/plugin-updater", () => plugin);

import { checkForUpdate } from "../updater";

describe("checkForUpdate", () => {
  it("有更新时返回 Update", async () => {
    const update = { version: "1.2.3" };
    plugin.check.mockResolvedValueOnce(update);
    await expect(checkForUpdate()).resolves.toBe(update);
  });

  it("已是最新时返回 null", async () => {
    plugin.check.mockResolvedValueOnce(null);
    await expect(checkForUpdate()).resolves.toBeNull();
  });
});
