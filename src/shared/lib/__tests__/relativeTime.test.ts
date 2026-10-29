import { describe, expect, it } from "vitest";

import { intlLocale } from "../locale";
import { formatRelativeTime, WEEK_MS } from "../relativeTime";

const NOW = Date.UTC(2026, 9, 27, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeTime：默认（分钟到天，阈值取整）", () => {
  it("各量级", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW, "zh-CN")).toBe("此刻");
    expect(formatRelativeTime(NOW - 3 * MIN, NOW, "zh-CN")).toBe("3分钟前");
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW, "en")).toBe("2 hours ago");
    expect(formatRelativeTime(NOW - DAY, NOW, "zh-CN")).toBe("昨天");
    expect(formatRelativeTime(NOW - 40 * DAY, NOW, "en")).toBe("40 days ago");
  });

  it("阈值取整不进位", () => {
    expect(formatRelativeTime(NOW - 59.6 * MIN, NOW, "en")).toBe("60 minutes ago");
  });

  it("将来的时间", () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW, "en")).toBe("in 5 minutes");
    expect(formatRelativeTime(NOW + DAY, NOW, "zh-CN")).toBe("明天");
  });

  it("达到阈值改显示日期", () => {
    const at = NOW - 8 * DAY;
    expect(formatRelativeTime(at, NOW, "en", { dateAfterMs: WEEK_MS })).toBe(new Date(at).toLocaleDateString("en"));
    expect(formatRelativeTime(NOW - 6 * DAY, NOW, "en", { dateAfterMs: WEEK_MS })).toBe("6 days ago");
  });

  it("可以粗到年，“现在”可以换用秒的表达", () => {
    const wide = { maxUnit: "year", nowUnit: "second" } as const;
    expect(formatRelativeTime(NOW - 20_000, NOW, "zh-CN", wide)).toBe("现在");
    expect(formatRelativeTime(NOW - 400 * DAY, NOW, "en", wide)).toBe("last year");
    expect(formatRelativeTime(NOW - 14 * DAY, NOW, "en", wide)).toBe("2 weeks ago");
  });
});

describe("formatRelativeTime：逐级取整（秒到天）", () => {
  const cascade = { minUnit: "second", maxUnit: "day", rounding: "cascade" } as const;
  it("秒级显示实际秒数，0 秒为“现在”", () => {
    expect(formatRelativeTime(NOW, NOW, "zh-CN", cascade)).toBe("现在");
    expect(formatRelativeTime(NOW - 12_000, NOW, "en", cascade)).toBe("12 seconds ago");
  });

  it("取整后够一个大单位就进位", () => {
    expect(formatRelativeTime(NOW - 59.6 * MIN, NOW, "en", cascade)).toBe("1 hour ago");
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW, "en", cascade)).toBe("2 hours ago");
    expect(formatRelativeTime(NOW - 23.7 * HOUR, NOW, "en", cascade)).toBe("yesterday");
  });
});

describe("intlLocale", () => {
  it("中文映射为 zh-CN，其余为 en", () => {
    expect(intlLocale("zh")).toBe("zh-CN");
    expect(intlLocale("zh-CN")).toBe("zh-CN");
    expect(intlLocale("en")).toBe("en");
    expect(intlLocale("fr")).toBe("en");
  });
});
