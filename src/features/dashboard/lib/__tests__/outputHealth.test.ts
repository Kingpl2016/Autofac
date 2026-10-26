import { describe, expect, it } from "vitest";

import { outputTone } from "../outputHealth";

describe("outputTone", () => {
  it("四种状态映射到不同色调", () => {
    expect(outputTone("idle")).toBe("idle");
    expect(outputTone("sending")).toBe("ready");
    expect(outputTone("dropping")).toBe("warning");
    expect(outputTone("error")).toBe("error");
  });
});