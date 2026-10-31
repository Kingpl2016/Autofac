// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { produce } from "immer";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

import i18n from "@/shared/i18n";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const mock = vi.hoisted(() => ({ model: null as unknown }));

const toolStream = (toolName: string, input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: "tool-call" as const, toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) },
    { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
  ]),
});
const textStream = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: "text-start" as const, id: "t" },
    { type: "text-delta" as const, id: "t", delta: text },
    { type: "text-end" as const, id: "t" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
  ]),
});

const profile = {
  id: "p1",
  name: "Mock",
  kind: "openaiCompatible",
  baseUrl: "http://localhost/v1",
  model: "m",
  supportsStructuredOutputs: false,
  inputModalities: [] as ("image" | "audio")[],
  temperature: 0,
  seed: null,
  hasKey: false,
} as const;

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));
vi.mock("@/features/ai", async () => {
  const errors = await import("@/features/ai/lib/errors");
  const prefs = await import("@/features/ai/stores/useAiPrefsStore");
  const memory = await import("@/features/ai/lib/memory");
  const memoryFile = await import("@/features/ai/lib/memoryFile");
  const memoryStore = await import("@/features/ai/stores/useAiMemoryStore");
  const skillStore = await import("@/features/ai/stores/useSkillStore");
  const mcpStore = await import("@/features/ai/stores/useMcpStore");
  const mcp = await import("@/features/ai/lib/mcp");
  const mcpApi = await import("@/features/ai/lib/mcpApi");
  return {
    ...errors,
    ...memory,
    ...memoryFile,
    ...memoryStore,
    ...skillStore,
    ...mcpStore,
    ...mcp,
    ...mcpApi,
    useAiPrefsStore: prefs.useAiPrefsStore,
    useActiveAiProfile: () => ({ profiles: [profile], profile, loading: false }),
    loadLanguageModel: async (p: unknown) => ({ model: mock.model, profile: p, settings: { temperature: 0 } }),
  };
});

import { addFixtures } from "../../../lib/ops";
import { createEmptyProject } from "../../../lib/project";
import { RGBW } from "../../../lib/__tests__/testkit";
import { useAiChatStore } from "../../../stores/useAiChatStore";
import { useAiStagingStore } from "../../../stores/useAiStagingStore";
import { useCueTemplateStore } from "../../../stores/useCueTemplateStore";
import { useEditorUiStore } from "../../../stores/useEditorUiStore";
import { useEffectLibraryStore } from "../../../stores/useEffectLibraryStore";
import { useProjectStore } from "../../../stores/useProjectStore";
import { useFixtureStore } from "@/features/fixtures";
import { useAiPrefsStore } from "@/features/ai/stores/useAiPrefsStore";
import { useAiMemoryStore } from "@/features/ai/stores/useAiMemoryStore";
import { useAiExemplarStore } from "../../../stores/useAiExemplarStore";
import { AskAiBody } from "../AskAiBody";
import { resetChatSession } from "../chatSession";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  resetChatSession();
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 16_000;
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
      d.sections = [{ id: "s1", name: "副歌", startMs: 4000, endMs: 12_000, color: [235, 90, 70] }];
    }),
  );
  useEditorUiStore.setState({ aiCollapsed: true, timeRange: null, selectedCueIds: [] });
  useAiStagingStore.setState({ staged: null, previewing: true, outcomes: {} });
  useAiChatStore.setState({ tree: [], headId: null, messages: [], path: null, profileId: null, notes: [], exemplars: [], memoryCards: {}, epoch: 70 });
  useAiMemoryStore.setState({ status: "ready", prefs: [] });
  useAiExemplarStore.setState({ status: "ready", items: [] });
  useAiPrefsStore.setState({ autoApply: false });
  useEffectLibraryStore.setState({ status: "ready", user: [] });
  useCueTemplateStore.setState({ status: "ready", user: [] });
  useFixtureStore.setState({ status: "ready", models: [] });
});

afterEach(() => cleanup());

describe("时间线上的问 AI", () => {
  it("段落范围：快捷建议直接发送，消息带范围说明；提议进暂存区但不打开对话栏", async () => {
    mock.model = new MockLanguageModelV4({
      doStream: [
        toolStream("propose_ops", { summary: "副歌呼吸", ops: [{ op: "addEffect", target: "all", from: "4s", to: "12s", effect: "breathe" }] }),
        textStream("已经给副歌加上呼吸效果。"),
      ],
    });
    render(<AskAiBody scope={{ kind: "section", id: "s1" }} />);
    expect(screen.getByText(/段落“副歌”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "给这一段编排灯光" }));

    expect(await screen.findByText("已经给副歌加上呼吸效果。")).toBeTruthy();
    await waitFor(() => expect(useAiStagingStore.getState().staged).not.toBeNull());
    // 范围落到编辑状态（这一轮的摘要里写出时间范围）
    expect(useEditorUiStore.getState().timeRange).toEqual({ startMs: 4000, endMs: 12_000 });
    // 对话栏保持收起；消息照常进对话记录
    expect(useEditorUiStore.getState().aiCollapsed).toBe(true);
    await waitFor(() => expect(useAiChatStore.getState().messages.length).toBe(2));
    const sent = useAiChatStore.getState().messages[0];
    const text = sent.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    expect(text).toMatch(/^给这一段编排灯光\n\n（范围：段落“副歌” /);
    // 弹层里可以直接应用 / 放弃
    expect(screen.getByRole("button", { name: /应用/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /在对话栏中查看/ })).toBeTruthy();
  });

  it("输入框 Enter 发送，空内容不发送", async () => {
    mock.model = new MockLanguageModelV4({ doStream: [textStream("好的")] });
    render(<AskAiBody scope={{ kind: "point", timeMs: 2000, trackId: null }} />);
    const input = screen.getByLabelText("问 AI 的内容");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "这里做什么好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("好的")).toBeTruthy();
    expect(useAiStagingStore.getState().staged).toBeNull();
  });
});
