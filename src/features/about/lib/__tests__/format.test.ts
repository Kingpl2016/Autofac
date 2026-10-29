import { describe, expect, it } from "vitest";

import type { AppInfo } from "../api";
import { formatBytes } from "@/shared/lib/format";
import { buildDiagnostics, formatPublishDate } from "../format";

describe("formatBytes", () => {
  it("按 1024 进位并保留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("负数与非有限值按 0 处理", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatPublishDate", () => {
  it("无法解析或缺失时返回 null", () => {
    expect(formatPublishDate(undefined, "en")).toBeNull();
    expect(formatPublishDate("not a date", "en")).toBeNull();
  });

  it("可解析时返回非空文本", () => {
    expect(formatPublishDate("2026-10-25T08:00:00Z", "en")).toMatch(/2026/);
  });
});

describe("buildDiagnostics", () => {
  it("生成包含版本、构建类型、系统与标识符的多行文本", () => {
    const info: AppInfo = {
      name: "Art-Net Studio",
      version: "0.1.0",
      identifier: "com.artnetstudio.app",
      tauriVersion: "2.12.0",
      os: "windows",
      arch: "x86_64",
      profile: "release",
    };
    expect(buildDiagnostics(info).split("\n")).toEqual([
      "Art-Net Studio 0.1.0 (release)",
      "Tauri 2.12.0",
      "OS: windows x86_64",
      "Identifier: com.artnetstudio.app",
    ]);
  });
});
