import { describe, expect, it } from "vitest";

import { setOutput } from "../ops";
import { createEmptyProject } from "../project";

describe("setOutput", () => {
  it("只改传入的字段，其余保持不变", () => {
    const p = createEmptyProject("t");
    setOutput(p, { loop: true });
    expect(p.output).toMatchObject({ loop: true, gamma: 1, latencyCompMs: 0 });
    expect(p.output.target.kind).toBe("direct");
  });

  it("Gamma 夹到 1~3 并保留 1 位小数", () => {
    const p = createEmptyProject("t");
    setOutput(p, { gamma: 7 });
    expect(p.output.gamma).toBe(3);
    setOutput(p, { gamma: 0.2 });
    expect(p.output.gamma).toBe(1);
    setOutput(p, { gamma: 2.26 });
    expect(p.output.gamma).toBe(2.3);
  });

  it("延迟补偿取整并夹到 ±1000 ms", () => {
    const p = createEmptyProject("t");
    setOutput(p, { latencyCompMs: 12.6 });
    expect(p.output.latencyCompMs).toBe(13);
    setOutput(p, { latencyCompMs: -5000 });
    expect(p.output.latencyCompMs).toBe(-1000);
    setOutput(p, { latencyCompMs: 5000 });
    expect(p.output.latencyCompMs).toBe(1000);
  });

  it("可以替换输出目标", () => {
    const p = createEmptyProject("t");
    setOutput(p, { target: { kind: "forwarding" } });
    expect(p.output.target).toEqual({ kind: "forwarding" });
  });
});
