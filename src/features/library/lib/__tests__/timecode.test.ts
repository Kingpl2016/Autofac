import { describe, expect, it } from "vitest";

import { formatTimecode, parseTimecode } from "../timecode";

describe("时间码", () => {
  it("格式化", () => {
    expect(formatTimecode(0)).toBe("0:00.000");
    expect(formatTimecode(65_432_100)).toBe("1:05.432");
    expect(formatTimecode(3_723_004_000)).toBe("1:02:03.004");
    expect(formatTimecode(-5)).toBe("0:00.000");
  });

  it.each([
    ["12", 12_000_000],
    ["12.5", 12_500_000],
    ["1:05.432", 65_432_000],
    ["1:05,4", 65_400_000],
    ["1:02:03.004", 3_723_004_000],
    [" 90 ", 90_000_000],
  ])("解析 %s", (text, us) => {
    expect(parseTimecode(text)).toBe(us);
  });

  it.each(["", "abc", "1:60", "1:60:00", "1.2.3", "-1"])("拒绝 %j", (text) => {
    expect(parseTimecode(text)).toBeNull();
  });

  it("格式化与解析往返一致", () => {
    for (const us of [0, 1_000, 59_999_000, 3_600_000_000, 7_265_123_000]) {
      expect(parseTimecode(formatTimecode(us))).toBe(us);
    }
  });
});
