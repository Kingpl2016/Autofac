import { describe, expect, it } from "vitest";

import { formatLastSeen } from "../format";

describe("formatLastSeen", () => {
  it("使用逻辑时间差而不是 epoch", () => {
    // 启动后 10 分钟，设备 3 分钟前活动
    const text = formatLastSeen(7 * 60_000, 10 * 60_000, "en");
    expect(text).toContain("3");
    expect(text).toContain("minute");
  });

  it("刚刚活动显示为“现在”，时钟回退不出现负数", () => {
    expect(formatLastSeen(5_000, 5_000, "zh")).toBe("现在");
    expect(formatLastSeen(6_000, 5_000, "zh")).toBe("现在");
  });

  it("超过一小时按小时显示", () => {
    expect(formatLastSeen(0, 2 * 3600_000, "en")).toContain("2 hours");
  });
});
