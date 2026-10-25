import { describe, expect, it } from "vitest";

import { formatUniverse, summarizePorts } from "../ports";

describe("formatUniverse", () => {
  it("拆成 Net:Sub:Uni", () => {
    expect(formatUniverse(0)).toBe("0:0:0");
    expect(formatUniverse((2 << 8) | (1 << 4) | 3)).toBe("2:1:3");
    expect(formatUniverse(0x7fff)).toBe("127:15:15");
  });
});

describe("summarizePorts", () => {
  it("分别统计输入与输出口", () => {
    expect(
      summarizePorts([
        { index: 0, direction: "input", universe: 0, active: false },
        { index: 0, direction: "output", universe: 1, active: true },
        { index: 1, direction: "output", universe: 2, active: false },
      ]),
    ).toEqual({ input: 1, output: 2 });
  });

  it("缺省时为 0", () => {
    expect(summarizePorts(undefined)).toEqual({ input: 0, output: 0 });
  });
});
