import { describe, expect, it } from "vitest";

import { conflictLevel } from "../conflict";

describe("conflictLevel", () => {
  it("没有冲突通道时为 none，与模式无关", () => {
    expect(conflictLevel("htp", 0)).toBe("none");
    expect(conflictLevel("ltp", 0)).toBe("none");
  });

  it("HTP 下只是提示，LTP / Priority 才是警告", () => {
    expect(conflictLevel("htp", 12)).toBe("info");
    expect(conflictLevel("ltp", 12)).toBe("warning");
    expect(conflictLevel("priority", 1)).toBe("warning");
  });
});