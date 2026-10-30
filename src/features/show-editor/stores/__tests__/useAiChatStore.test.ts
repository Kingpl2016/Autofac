import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  files: new Map<string, string>(),
  aiHistoryRead: vi.fn(async (path: string) => api.files.get(path) ?? null),
  aiHistoryWrite: vi.fn(async (path: string, text: string) => void api.files.set(path, text)),
  aiHistoryLibraryPath: vi.fn(async (entry: string) => `D:/data/ai-history/${entry}.ai.json`),
}));
vi.mock("@/features/ai/lib/api", () => api);

import {
  chainTree,
  currentBranch,
  emptyChatDoc,
  MAX_BRANCH_MESSAGES,
  mergeBranch,
  parseHistory,
  pruneTree,
  serializeHistory,
  type ChatDoc,
  type TreeItem,
} from "../../ai/history";
import { makeExemplar } from "../../ai/memory";
import { clearChat, moveChatDocument, switchChatDocument, useAiChatStore } from "../useAiChatStore";
import { useAiStagingStore } from "../useAiStagingStore";

const msg = (id: string, text: string, role: UIMessage["role"] = "user"): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const flush = () => new Promise((r) => setTimeout(r, 1100));
const doc = (over: Partial<ChatDoc>): ChatDoc => ({ ...emptyChatDoc(), ...over });
const ids = (tree: readonly TreeItem[]) => tree.map((t) => t.message.id);

beforeEach(() => {
  api.files.clear();
  vi.clearAllMocks();
  useAiStagingStore.setState({ outcomes: {} });
});

describe("对话记录文件（第 2 版：消息树）", () => {
  // u1 → a1 → u2 → a2，a1 重新生成出 a1b（u1 → a1b）
  const tree: TreeItem[] = [
    ...chainTree([msg("u1", "1"), msg("a1", "a", "assistant"), msg("u2", "2"), msg("a2", "b", "assistant")]),
    { parentId: "u1", message: msg("a1b", "a'", "assistant") },
  ];

  it("当前版本沿 headId 往回走；不在树里时为空", () => {
    expect(currentBranch(tree, "a2").map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(currentBranch(tree, "a1b").map((m) => m.id)).toEqual(["u1", "a1b"]);
    expect(currentBranch(tree, "nope")).toEqual([]);
  });

  it("并入当前版本：已有的原地更新，新的加在后面", () => {
    const merged = mergeBranch(tree, [msg("u1", "1"), msg("a1b", "a''", "assistant"), msg("u3", "3")]);
    expect(ids(merged)).toEqual(["u1", "a1", "u2", "a2", "a1b", "u3"]);
    expect(merged.find((t) => t.message.id === "u3")?.parentId).toBe("a1b");
    expect(merged[4].message.parts).toEqual([{ type: "text", text: "a''" }]);
  });

  it("往返：树、当前版本、卡片结局与本工程记忆都保留；不在树里的结局丢掉", () => {
    const ex = makeExemplar("副歌改蓝紫", "s", [{ op: "editCues", cues: ["C3"], colors: ["blue"], speed: null }], 5)!;
    const note = { id: "n-1", text: "G1 是前排", enabled: false, createdAt: 1 };
    // a2 里有一个 propose_ops 调用（t1）
    const withTool = tree.map((t) =>
      t.message.id === "a2"
        ? { ...t, message: { ...t.message, parts: [{ type: "tool-propose_ops", toolCallId: "t1", state: "output-available", input: {}, output: {} }] } as UIMessage }
        : t,
    );
    const text = serializeHistory(
      doc({ tree: withTool, headId: "a1b", profileId: "p1", proposals: { t1: "applied", gone: "discarded" }, memoryCards: { gone: "saved" }, notes: [note], exemplars: [ex] }),
    );
    const back = parseHistory(text);
    expect(ids(back.tree)).toEqual(ids(tree));
    expect(back.headId).toBe("a1b");
    expect(back.profileId).toBe("p1");
    expect(back.proposals).toEqual({ t1: "applied" });
    expect(back.memoryCards).toEqual({});
    expect(back.notes).toEqual([note]);
    expect(back.exemplars[0]).toMatchObject({ request: "副歌改蓝紫", ops: [{ op: "editCues", cues: ["C3"], colors: ["blue"] }] });
  });

  it("第 1 版读成一条线；版本或结构不对时当作没有记录", () => {
    const v1 = JSON.stringify({ version: 1, promptVersion: 1, profileId: "p", messages: [msg("1", "a"), msg("2", "b", "assistant")] });
    const back = parseHistory(v1);
    expect(back.tree).toEqual(chainTree([msg("1", "a"), msg("2", "b", "assistant")]));
    expect(back.headId).toBe("2");
    expect(back.profileId).toBe("p");
    expect(parseHistory(JSON.stringify({ version: 99 }))).toEqual(emptyChatDoc());
    expect(parseHistory("{oops")).toEqual(emptyChatDoc());
  });

  it("修剪：当前版本只留最近的；整棵树超限时先删最早的、不在当前版本上的分支", () => {
    const long = Array.from({ length: MAX_BRANCH_MESSAGES + 5 }, (_, i) => msg(`m${i}`, `${i}`));
    const pruned = pruneTree(chainTree(long), `m${long.length - 1}`);
    expect(pruned).toHaveLength(MAX_BRANCH_MESSAGES);
    expect(pruned[0]).toMatchObject({ parentId: null, message: { id: "m5" } });

    // 当前版本 u1 → a1b；a1 那条分支（a1 → u2 → a2）最早，先删
    expect(ids(pruneTree(tree, "a1b", { maxBranch: 10, maxTree: 3 }))).toEqual(["u1", "a1b"]);
    // 当前版本超长时，挂在被删掉的开头上的其它分支一起删
    expect(ids(pruneTree(tree, "a2", { maxBranch: 3, maxTree: 10 }))).toEqual(["a1", "u2", "a2"]);
  });
});

describe("当前工程的 AI 对话", () => {
  it("库外工程的记录放在工程旁；换工程时读入树与当前版本；同一工程回到编辑器不重读", async () => {
    api.files.set(
      "D:/show/a.artshow.ai.json",
      serializeHistory(doc({ tree: [...chainTree([msg("1", "你好"), msg("2", "a", "assistant")]), { parentId: "1", message: msg("2b", "b", "assistant") }], headId: "2b", proposals: { t: "applied" } })),
    );
    await switchChatDocument(101, { kind: "external", path: "D:/show/a.artshow" });
    expect(useAiChatStore.getState().messages.map((m) => m.id)).toEqual(["1", "2b"]);
    expect(useAiChatStore.getState().tree).toHaveLength(3);
    const epoch = useAiChatStore.getState().epoch;
    await switchChatDocument(101, { kind: "external", path: "D:/show/a.artshow" });
    expect(useAiChatStore.getState().epoch).toBe(epoch);

    // 切回第一个版本再继续：树里三个版本都在，写盘后当前版本是新的
    useAiChatStore.getState().setMessages([msg("1", "你好"), msg("2", "a", "assistant"), msg("3", "再见")]);
    await flush();
    const back = parseHistory(api.files.get("D:/show/a.artshow.ai.json") ?? "");
    expect(ids(back.tree)).toEqual(["1", "2", "2b", "3"]);
    expect(back.headId).toBe("3");
  });

  it("面板刚挂载时的空消息不改树；配置跟着记下", async () => {
    await switchChatDocument(150, { kind: "none" });
    useAiChatStore.getState().setMessages([msg("1", "a")], "p1");
    useAiChatStore.getState().setMessages([], "p1");
    expect(useAiChatStore.getState()).toMatchObject({ headId: "1", profileId: "p1" });
    expect(useAiChatStore.getState().messages).toHaveLength(1);
  });

  it("未保存的工程只在内存里；第一次保存（另存为）时连同记忆搬到新位置；节目库用数据目录", async () => {
    await switchChatDocument(202, { kind: "none" });
    // 换工程时会先把上一个工程的对话写盘，这里只看之后的写入
    api.aiHistoryWrite.mockClear();
    useAiChatStore.getState().setMessages([msg("x", "未保存时的对话")]);
    useAiChatStore.getState().addNote("这首歌副歌都用蓝紫");
    await flush();
    expect(api.aiHistoryWrite).not.toHaveBeenCalled();
    await moveChatDocument({ kind: "library", path: "D:/rec/秀.artrec" });
    const [path] = api.aiHistoryWrite.mock.calls[0];
    expect(path).toMatch(/^D:\/data\/ai-history\/lib-[0-9a-f]{16}\.ai\.json$/);
    const back = parseHistory(api.files.get(path) ?? "");
    expect(back.tree[0].message.id).toBe("x");
    expect(back.notes.map((n) => n.text)).toEqual(["这首歌副歌都用蓝紫"]);
  });

  it("本工程笔记与范例：去重、启用开关、删除；结局变化也写盘", async () => {
    await switchChatDocument(250, { kind: "external", path: "D:/show/b.artshow" });
    const s = useAiChatStore.getState();
    expect(s.addNote("G1 是前排帕灯")).toBe(false);
    expect(useAiChatStore.getState().addNote(" G1 是前排帕灯。")).toBe(true);
    expect(useAiChatStore.getState().notes).toHaveLength(1);
    const id = useAiChatStore.getState().notes[0].id;
    useAiChatStore.getState().updateNote(id, { enabled: false });
    expect(useAiChatStore.getState().notes[0].enabled).toBe(false);

    const a = makeExemplar("副歌改蓝紫", "s", [{ op: "editCues" }], 1)!;
    const b = makeExemplar("副歌改蓝紫", "s2", [{ op: "editCues", speed: "x2" }], 2)!;
    useAiChatStore.getState().addExemplar(a);
    useAiChatStore.getState().addExemplar(b);
    expect(useAiChatStore.getState().exemplars.map((e) => e.summary)).toEqual(["s2"]);
    useAiChatStore.getState().removeExemplar(b.id);
    expect(useAiChatStore.getState().exemplars).toEqual([]);

    useAiChatStore.getState().setMessages([msg("1", "a")]);
    useAiChatStore.getState().setMemoryCard("m1", "saved");
    await flush();
    api.aiHistoryWrite.mockClear();
    useAiStagingStore.setState({ outcomes: { t9: "discarded" } });
    await flush();
    expect(api.aiHistoryWrite).toHaveBeenCalledTimes(1);
  });

  it("清空对话：消息树清空、会话序号递增，本工程的记忆保留", async () => {
    await switchChatDocument(303, { kind: "none" });
    useAiChatStore.getState().setMessages([msg("a", "1")]);
    useAiChatStore.getState().addNote("保留我");
    const epoch = useAiChatStore.getState().epoch;
    clearChat();
    expect(useAiChatStore.getState()).toMatchObject({ messages: [], tree: [], headId: null, epoch: epoch + 1 });
    expect(useAiChatStore.getState().notes).toHaveLength(1);
  });
});
