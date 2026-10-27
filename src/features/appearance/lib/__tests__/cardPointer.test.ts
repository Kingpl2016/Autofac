// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  applyCardPointerVars,
  computeCardPointerVars,
  MAX_TILT_DEG,
  resetCardPointerVars,
} from "../cardPointer";

const rect = { left: 100, top: 50, width: 200, height: 100 };

describe("computeCardPointerVars", () => {
  it("指针在卡片中心：聚光灯在中心，倾斜为 0", () => {
    const vars = computeCardPointerVars({ rect, clientX: 200, clientY: 100 });
    expect(vars["--card-mx"]).toBe("100px");
    expect(vars["--card-my"]).toBe("50px");
    expect(vars["--card-gx"]).toBe("50%");
    expect(Number.parseFloat(vars["--card-rx"])).toBeCloseTo(0, 5);
    expect(Number.parseFloat(vars["--card-ry"])).toBeCloseTo(0, 5);
  });

  it("指针在右下角：倾斜达到最大角度，方向符合预期", () => {
    const vars = computeCardPointerVars({ rect, clientX: 300, clientY: 150 });
    expect(Number.parseFloat(vars["--card-ry"])).toBeCloseTo(MAX_TILT_DEG, 1);
    expect(Number.parseFloat(vars["--card-rx"])).toBeCloseTo(-MAX_TILT_DEG, 1);
  });

  it("指针在卡片之外：位置被限制在 0~1", () => {
    const vars = computeCardPointerVars({ rect, clientX: -500, clientY: 9999 });
    expect(vars["--card-mx"]).toBe("0px");
    expect(vars["--card-my"]).toBe("100px");
  });

  it("卡片尺寸为 0 时返回居中值，不出现 NaN", () => {
    const vars = computeCardPointerVars({
      rect: { left: 0, top: 0, width: 0, height: 0 },
      clientX: 10,
      clientY: 10,
    });
    expect(Object.values(vars).some((v) => v.includes("NaN"))).toBe(false);
    expect(vars["--card-gx"]).toBe("50%");
  });
});

describe("apply / reset", () => {
  it("写入变量并标记活动，复位后全部清除", () => {
    const card = document.createElement("div");
    applyCardPointerVars(card, computeCardPointerVars({ rect, clientX: 150, clientY: 75 }));
    expect(card.style.getPropertyValue("--card-mx")).not.toBe("");
    expect(card.dataset.cardActive).toBe("");

    resetCardPointerVars(card);
    expect(card.style.getPropertyValue("--card-mx")).toBe("");
    expect(card.style.getPropertyValue("--card-rx")).toBe("");
    expect(card.dataset.cardActive).toBeUndefined();
  });
});
