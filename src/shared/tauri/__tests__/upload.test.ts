import { describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  upload: vi.fn(async () => "ok"),
  download: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-upload", () => plugin);

import { uploadFile, downloadFile } from "../upload";

describe("uploadFile / downloadFile", () => {
  it("透传参数到插件", async () => {
    const onProgress = vi.fn();
    await expect(uploadFile("https://x/up", "/a/b.txt", onProgress)).resolves.toBe(
      "ok",
    );
    expect(plugin.upload).toHaveBeenCalledWith(
      "https://x/up",
      "/a/b.txt",
      onProgress,
      undefined,
    );

    await downloadFile("https://x/dl", "/a/c.txt");
    expect(plugin.download).toHaveBeenCalledWith(
      "https://x/dl",
      "/a/c.txt",
      undefined,
      undefined,
    );
  });
});
