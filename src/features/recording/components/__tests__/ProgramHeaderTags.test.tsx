// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { HeaderInfo } from "../../lib/types";
import { ProgramHeaderTags } from "../ProgramHeaderTags";

const header = (over: Partial<HeaderInfo> = {}): HeaderInfo => ({
  verMajor: 1,
  verMinor: 0,
  compression: "zstd",
  compressLevel: 3,
  loopFlag: false,
  diffFrames: false,
  frameIndexAtTail: true,
  issues: [],
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => cleanup());

describe("ProgramHeaderTags", () => {
  it("没有文件头信息时不渲染", () => {
    const { container } = render(<ProgramHeaderTags header={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("普通节目只显示格式版本与压缩", () => {
    render(<ProgramHeaderTags header={header()} />);
    const group = screen.getByRole("group", { name: "文件头信息" });
    expect(group.textContent).toBe("v1.0 · Zstd L3");
  });

  it("循环、差分帧与问题都有标签，告警类带图标且可键盘聚焦", () => {
    render(
      <ProgramHeaderTags
        header={header({
          compression: "none",
          loopFlag: true,
          diffFrames: true,
          issues: ["durationMismatch", "newerMinor"],
        })}
      />,
    );
    const group = screen.getByRole("group", { name: "文件头信息" });
    expect(group.textContent).toContain("v1.0 · 无压缩");
    expect(group.textContent).toContain("循环");
    expect(group.textContent).toContain("差分帧");
    expect(group.textContent).toContain("时长不一致");
    expect(group.textContent).toContain("较新格式");
    // 差分帧 + 两个问题：3 个告警图标
    expect(group.querySelectorAll("svg")).toHaveLength(3);
    for (const el of group.querySelectorAll("[tabindex='0']")) {
      expect(el.className).toContain("focus-visible:ring-2");
    }
  });
});
