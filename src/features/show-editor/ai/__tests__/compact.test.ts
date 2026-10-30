import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { compactHistory } from "../compact";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const say = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, toolName: string, input: unknown): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const result = (id: string, toolName: string): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: "很长的结果".repeat(50) } }],
});

/** 一轮：用户 → 查片段 → 提议 → 回复。 */
const turn = (n: number): ModelMessage[] => [
  user(`第 ${n} 句`),
  call(`l${n}`, "list_cues", {}),
  result(`l${n}`, "list_cues"),
  call(`p${n}`, "propose_ops", { summary: `改动 ${n}`, ops: [] }),
  result(`p${n}`, "propose_ops"),
  say(`好了 ${n}`),
];

describe("长对话压缩", () => {
  it("轮数不多时原样返回", () => {
    const messages = [...turn(1), ...turn(2)];
    expect(compactHistory(messages, { keepTurns: 4 })).toEqual(messages);
  });

  it("较早的轮次去掉工具细节，提议换成带结局的一行；最近的轮次原样保留", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];
    const out = compactHistory(messages, { keepTurns: 2, outcomeOf: (id) => (id === "p1" ? "applied" : undefined) });
    expect(out.slice(0, 3)).toEqual([
      user("第 1 句"),
      { role: "assistant", content: [{ type: "text", text: "[proposed a change: 改动 1 (applied)]" }] },
      say("好了 1"),
    ]);
    expect(out.slice(3)).toEqual([...turn(2), ...turn(3)]);
    // 不留下没有调用的工具结果
    expect(out.slice(0, 3).some((m) => m.role === "tool")).toBe(false);
  });

  it("remember 换成一行；没有结局时写 pending；推理过程删掉", () => {
    const messages: ModelMessage[] = [
      user("记住不要频闪"),
      { role: "assistant", content: [{ type: "reasoning", text: "想一想" }, { type: "tool-call", toolCallId: "r", toolName: "remember", input: { scope: "user", text: "不要频闪" } }] },
      result("r", "remember"),
      ...turn(2),
    ];
    expect(compactHistory(messages, { keepTurns: 1 }).slice(0, 2)).toEqual([
      user("记住不要频闪"),
      { role: "assistant", content: [{ type: "text", text: '[asked to remember: "不要频闪" (pending)]' }] },
    ]);
  });

  it("仍然太长时从最早的整轮删起，保留的轮次不动；结果确定", () => {
    const messages = Array.from({ length: 10 }, (_, i) => turn(i + 1)).flat();
    const out = compactHistory(messages, { keepTurns: 2, maxMessages: 20 });
    expect(out.length).toBeLessThanOrEqual(20);
    // 保留 2 轮（12 条），剩 8 条给压缩后的轮次（每轮 3 条）：只放得下第 7、8 轮
    expect(out[0]).toEqual(user("第 7 句"));
    expect(out).toHaveLength(18);
    expect(out.slice(-12)).toEqual([...turn(9), ...turn(10)]);
    expect(compactHistory(messages, { keepTurns: 2, maxMessages: 20 })).toEqual(out);
  });
});
