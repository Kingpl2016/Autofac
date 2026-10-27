import { describe, expect, it } from "vitest";

import { splitUptime } from "../uptime";

describe("splitUptime", () => {
  it("按量级选择展示粒度", () => {
    expect(splitUptime(0)).toMatchObject({ unit: "seconds", seconds: 0 });
    expect(splitUptime(45)).toMatchObject({ unit: "seconds", seconds: 45 });
    expect(splitUptime(200)).toMatchObject({ unit: "minutes", minutes: 3, seconds: 20 });
    expect(splitUptime(3725)).toMatchObject({ unit: "hours", hours: 1, minutes: 2 });
    expect(splitUptime(12_420)).toMatchObject({ unit: "hours", hours: 3, minutes: 27 });
    expect(splitUptime(90_000)).toMatchObject({ unit: "days", days: 1, hours: 1 });
  });

  it("边界：恰好 1 分钟 / 1 小时 / 1 天进位", () => {
    expect(splitUptime(59).unit).toBe("seconds");
    expect(splitUptime(60).unit).toBe("minutes");
    expect(splitUptime(3599).unit).toBe("minutes");
    expect(splitUptime(3600).unit).toBe("hours");
    expect(splitUptime(86_399).unit).toBe("hours");
    expect(splitUptime(86_400).unit).toBe("days");
  });

  it("非法输入按 0 处理，小数向下取整", () => {
    expect(splitUptime(-5)).toMatchObject({ unit: "seconds", seconds: 0 });
    expect(splitUptime(Number.NaN)).toMatchObject({ unit: "seconds", seconds: 0 });
    expect(splitUptime(61.9)).toMatchObject({ unit: "minutes", minutes: 1, seconds: 1 });
  });
});
