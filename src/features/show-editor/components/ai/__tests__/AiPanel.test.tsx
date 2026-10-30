// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { produce } from "immer";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const mock = vi.hoisted(() => ({ model: null as unknown }));

/** 一次流式响应：工具调用。 */
const toolStream = (toolName: string, input: unknown, id = `c-${toolName}`) => ({
  stream: convertArrayToReadableStream([
    { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
  ]),
});
/** 一次流式响应：文字。 */
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
  // 记忆用真的（没有 Tauri 时读写静默失败，只在内存里）
  const memory = await import("@/features/ai/lib/memory");
  const memoryFile = await import("@/features/ai/lib/memoryFile");
  const memoryStore = await import("@/features/ai/stores/useAiMemoryStore");
  return {
    ...errors,
    ...memory,
    ...memoryFile,
    ...memoryStore,
    useAiPrefsStore: prefs.useAiPrefsStore,
    useActiveAiProfile: () => ({ profiles: [profile, { ...profile, id: "p2", name: "Other", model: "m2" }], profile, loading: false }),
    loadLanguageModel: async (p: unknown) => ({ model: mock.model, profile: p, settings: { temperature: 0 } }),
  };
});

import { addFixtures } from "../../../lib/ops";
import { createEmptyProject } from "../../../lib/project";
import { RGBW } from "../../../lib/__tests__/testkit";
import { useAiChatStore } from "../../../stores/useAiChatStore";
import { useAiStagingStore } from "../../../stores/useAiStagingStore";
import { useEffectLibraryStore } from "../../../stores/useEffectLibraryStore";
import { useCueTemplateStore } from "../../../stores/useCueTemplateStore";
import { useProjectStore } from "../../../stores/useProjectStore";
import { useFixtureStore } from "@/features/fixtures";
import { useAiPrefsStore } from "@/features/ai/stores/useAiPrefsStore";
import { useAiMemoryStore } from "@/features/ai/stores/useAiMemoryStore";
import { useAiExemplarStore } from "../../../stores/useAiExemplarStore";
import { AiChatPanel } from "../AiChatPanel";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // assistant-ui 的视口用到 scrollTo
  Element.prototype.scrollTo = vi.fn() as never;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  stubResizeObserver();
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 16_000;
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    }),
  );
  useAiStagingStore.setState({ staged: null, previewing: true, outcomes: {} });
  useAiChatStore.setState({ tree: [], headId: null, messages: [], path: null, profileId: null, notes: [], exemplars: [], memoryCards: {} });
  useAiMemoryStore.setState({ status: "ready", prefs: [] });
  useAiExemplarStore.setState({ status: "ready", items: [] });
  useAiPrefsStore.setState({ autoApply: false });
  // 词汇表已读入（不走后端）
  useEffectLibraryStore.setState({ status: "ready", user: [] });
  useCueTemplateStore.setState({ status: "ready", user: [] });
  useFixtureStore.setState({ status: "ready", models: [] });
});

afterEach(() => cleanup());

const renderPanel = (session = 0) =>
  render(
    <MemoryRouter>
      <AiChatPanel profile={profile} session={session} />
    </MemoryRouter>,
  );

/** 在输入框里发一条消息。 */
async function send(text: string) {
  const input = await screen.findByLabelText("给 AI 的消息");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}

describe("AI 对话面板（assistant-ui）", () => {
  it("空状态显示建议问题；发送后模型的提议进入暂存区，提议卡片可以直接应用", async () => {
    mock.model = new MockLanguageModelV4({
      doStream: [
        toolStream("propose_ops", { summary: "全部灯呼吸", ops: [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "breathe" }] }),
        textStream("好的，**已准备好**。"),
      ],
    });
    renderPanel();
    expect(await screen.findByText("想让灯光怎么变？")).toBeTruthy();
    expect(screen.getByRole("button", { name: /把选中的片段改成蓝紫色/ })).toBeTruthy();
    await send("前四小节呼吸");
    // Markdown 渲染
    const strong = await screen.findByText("已准备好");
    expect(strong.tagName).toBe("STRONG");
    await waitFor(() => expect(useAiStagingStore.getState().staged).not.toBeNull());
    expect(useAiStagingStore.getState().staged?.sourceId).toBe("c-propose_ops");
    // 对话写回 store（跟着工程保存）
    await waitFor(() => expect(useAiChatStore.getState().messages.length).toBe(2));

    const card = screen.getByText("AI 准备的改动").closest("div")!.parentElement!;
    expect(within(card).getByText("全部灯呼吸")).toBeTruthy();
    expect(within(card).getByText(/新增 1 个片段/)).toBeTruthy();
    act(() => fireEvent.click(within(card).getByRole("button", { name: /应用/ })));
    expect(useProjectStore.getState().project.cues).toHaveLength(1);
    expect(await within(card).findByText("已应用")).toBeTruthy();
  });

  it("开了自动写入：点建议问题发送，不敏感的改动直接写入", async () => {
    useAiPrefsStore.setState({ autoApply: true });
    mock.model = new MockLanguageModelV4({
      doStream: [toolStream("propose_ops", { summary: "s", ops: [{ op: "addMarker", at: "b2", label: "drop" }] }), textStream("完成")],
    });
    renderPanel(1);
    fireEvent.click(await screen.findByRole("button", { name: /这个节目现在有哪些段落/ }));
    await waitFor(() => expect(useProjectStore.getState().project.markers).toHaveLength(1));
    expect(useAiStagingStore.getState().staged).toBeNull();
  });

  it("只读工具显示成可展开的步骤；重新生成产生新版本，可以在版本之间切换", async () => {
    mock.model = new MockLanguageModelV4({
      doStream: [toolStream("list_cues", { target: null, from: null, to: null }), textStream("还没有片段。"), textStream("现在没有片段。")],
    });
    renderPanel(2);
    await send("有哪些片段？");
    expect(await screen.findByText("还没有片段。")).toBeTruthy();
    const step = screen.getByRole("button", { name: /查看片段/ });
    fireEvent.click(step);
    expect(await screen.findByText("no clips match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(await screen.findByText("现在没有片段。")).toBeTruthy();
    expect(screen.getByText(/2\s*\/\s*2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上一个版本" }));
    expect(await screen.findByText("还没有片段。")).toBeTruthy();
    // 切到第一个版本也记下；重建面板（重开工程 / 换配置）后两个版本都在，停在第一个
    await waitFor(() => expect(useAiChatStore.getState().tree).toHaveLength(3));
    await waitFor(() => expect(useAiChatStore.getState().messages.at(-1)?.parts.some((p) => p.type === "text" && p.text === "还没有片段。")).toBe(true));
    cleanup();
    renderPanel(22);
    expect(await screen.findByText("还没有片段。")).toBeTruthy();
    expect(screen.queryByText("现在没有片段。")).toBeNull();
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一个版本" }));
    expect(await screen.findByText("现在没有片段。")).toBeTruthy();
  });

  it("应用过的提议重建面板后仍显示“已应用”，并记成范例", async () => {
    mock.model = new MockLanguageModelV4({
      doStream: [toolStream("propose_ops", { summary: "全部灯呼吸", ops: [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "breathe" }] }), textStream("好")],
    });
    renderPanel(4);
    await send("前四小节呼吸");
    const card = (await screen.findByText("AI 准备的改动")).closest("div")!.parentElement!;
    act(() => fireEvent.click(within(card).getByRole("button", { name: /应用/ })));
    expect(useAiChatStore.getState().exemplars).toMatchObject([{ request: "前四小节呼吸", summary: "全部灯呼吸" }]);
    // 不含工程别名：也记进所有工程共用的范例
    expect(useAiExemplarStore.getState().items).toHaveLength(1);
    cleanup();
    renderPanel(44);
    expect(await screen.findByText("已应用")).toBeTruthy();
  });

  it("输入框旁的自动写入开关与设置是同一个偏好", async () => {
    mock.model = new MockLanguageModelV4({ doStream: [textStream("hi")] });
    renderPanel(5);
    const toggle = await screen.findByRole("button", { name: "自动写入" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(useAiPrefsStore.getState().autoApply).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(toggle).getByText("自动")).toBeTruthy();
    // 在设置页关掉：输入框旁的开关跟着变
    act(() => {
      useAiPrefsStore.getState().setAutoApply(false);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "自动写入" }).getAttribute("aria-pressed")).toBe("false"));
  });

  it("记忆放进提示词，回复下方显示参考了几条；停用后下一轮不再带上", async () => {
    useAiMemoryStore.setState({ prefs: [{ id: "u-1", text: "不要频闪", enabled: true, createdAt: 1 }] });
    mock.model = new MockLanguageModelV4({ doStream: [textStream("记住了，不用频闪。"), textStream("好的。")] });
    renderPanel(6);
    await send("来点效果");
    expect(await screen.findByText("记住了，不用频闪。")).toBeTruthy();
    const model = mock.model as MockLanguageModelV4;
    expect(JSON.stringify(model.doStreamCalls[0].prompt[0])).toContain("- 不要频闪");
    const sources = await screen.findByRole("button", { name: "参考了 1 条记忆" });
    fireEvent.click(sources);
    expect(await screen.findByText("不要频闪")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停用这条记忆" }));
    expect(useAiMemoryStore.getState().prefs[0].enabled).toBe(false);
    await send("再来");
    expect(await screen.findByText("好的。")).toBeTruthy();
    expect(JSON.stringify(model.doStreamCalls[1].prompt[0])).not.toContain("不要频闪");
  });

  it("模型提出记住一条偏好：卡片上保存后写入个人偏好；忽略的不写", async () => {
    mock.model = new MockLanguageModelV4({
      doStream: [
        toolStream("remember", { scope: "user", text: "以后都不要频闪" }, "r1"),
        toolStream("remember", { scope: "show", text: "副歌都用蓝紫" }, "r2"),
        textStream("好的。"),
      ],
    });
    renderPanel(7);
    await send("记住以后都不要频闪，还有这首歌副歌都用蓝紫");
    expect(await screen.findByText("好的。")).toBeTruthy();
    const [first, second] = screen.getAllByText("要记住吗？").map((el) => el.closest("[data-memory-card]") as HTMLElement);
    expect(within(first).getByText("以后都不要频闪")).toBeTruthy();
    expect(within(first).getByText("个人偏好")).toBeTruthy();
    fireEvent.click(within(first).getByRole("button", { name: "保存" }));
    expect(useAiMemoryStore.getState().prefs.map((p) => p.text)).toEqual(["以后都不要频闪"]);
    expect(await within(first).findByText("已保存")).toBeTruthy();
    expect(within(second).getByText("本工程")).toBeTruthy();
    fireEvent.click(within(second).getByRole("button", { name: "忽略" }));
    expect(useAiChatStore.getState().notes).toEqual([]);
    expect(useAiChatStore.getState().memoryCards).toEqual({ r1: "saved", r2: "ignored" });
  });

  it("输入框底部的模型菜单切换本次对话的配置", async () => {
    mock.model = new MockLanguageModelV4({ doStream: [textStream("hi")] });
    renderPanel(3);
    const trigger = await screen.findByRole("button", { name: "使用的模型：Mock" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Other/ }));
    expect(useAiChatStore.getState().profileId).toBe("p2");
  });
});
