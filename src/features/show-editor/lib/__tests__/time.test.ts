import { describe, expect, it } from "vitest";

import { clamp } from "@/shared/lib/math";
import { formatTimecode, parseJumpTime, parseTimecode, snapToFrame } from "../time";

describe("formatTimecode", () => {
  it("分:秒.帧，帧按 30 FPS", () => {
    expect(formatTimecode(0)).toBe("00:00.00");
    expect(formatTimecode(1000)).toBe("00:01.00");
    expect(formatTimecode(1500)).toBe("00:01.15");
    expect(formatTimecode(61_033)).toBe("01:01.00");
    expect(formatTimecode(999)).toBe("00:00.29");
  });

  it("一小时以上带小时位，负数按 0", () => {
    expect(formatTimecode(3_723_000)).toBe("1:02:03.00");
    expect(formatTimecode(-50)).toBe("00:00.00");
  });
});

describe("parseTimecode", () => {
  it("接受 mm:ss.ff、ss、ss.ff 与 h:mm:ss", () => {
    expect(parseTimecode("01:01.15")).toBe(61_500);
    expect(parseTimecode("5")).toBe(5000);
    expect(parseTimecode("5.15")).toBe(5500);
    expect(parseTimecode("1:02:03")).toBe(3_723_000);
  });

  it("与 formatTimecode 互逆（在帧精度内）", () => {
    for (const ms of [0, 33, 500, 1500, 61_033, 3_723_000]) {
      const text = formatTimecode(ms);
      const back = parseTimecode(text);
      expect(back).not.toBeNull();
      expect(Math.abs((back ?? 0) - ms)).toBeLessThan(34);
    }
  });

  it("非法输入返回 null", () => {
    for (const bad of ["", "abc", "1:", ":10", "1.2.3", "00:00.30", "-5", "1:2:3:4", "00:xx"]) {
      expect(parseTimecode(bad), bad).toBeNull();
    }
  });
});

describe("parseJumpTime", () => {
  it("时间码与带单位的数值（秒 / 毫秒 / 帧），不区分大小写、忽略空格", () => {
    expect(parseJumpTime("1:23.10", 0)).toBe(83_333);
    expect(parseJumpTime("83", 0)).toBe(83_000);
    expect(parseJumpTime("83s", 0)).toBe(83_000);
    expect(parseJumpTime("1.5S", 0)).toBe(1500);
    expect(parseJumpTime(" 1500 ms ", 0)).toBe(1500);
    expect(parseJumpTime("12f", 0)).toBe(400);
  });

  it("+ / - 相对当前位置，结果不小于 0", () => {
    expect(parseJumpTime("+2s", 5000)).toBe(7000);
    expect(parseJumpTime("-10f", 1000)).toBe(667);
    expect(parseJumpTime("+0:30", 1000)).toBe(31_000);
    expect(parseJumpTime("-10s", 1000)).toBe(0);
  });

  it("无法解析时为 null", () => {
    for (const bad of ["", "  ", "abc", "1x", "+", "--1", "1.2.3s", "00:00.30"]) {
      expect(parseJumpTime(bad, 1000), bad).toBeNull();
    }
  });
});

describe("snapToFrame / clamp", () => {
  it("对齐到 1/30 秒的整数毫秒", () => {
    expect(snapToFrame(0)).toBe(0);
    expect(snapToFrame(10)).toBe(0);
    expect(snapToFrame(20)).toBe(33);
    expect(snapToFrame(1000)).toBe(1000);
  });

  it("夹取", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
