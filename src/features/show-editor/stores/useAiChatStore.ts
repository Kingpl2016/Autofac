import type { UIMessage } from "ai";
import { create } from "zustand";

import { addMemory, aiHistoryRead, aiHistoryWrite, removeMemory, updateMemory, type MemoryItem } from "@/features/ai";
import {
  currentBranch,
  emptyChatDoc,
  historyPath,
  mergeBranch,
  parseHistory,
  serializeHistory,
  type MediaDoc,
  type MemoryCardOutcome,
  type ToolApprovalOutcome,
  type TreeItem,
} from "../ai/history";
import { addExemplar, MAX_SHOW_EXEMPLARS, type Exemplar } from "../ai/memory";
import { useAiStagingStore } from "./useAiStagingStore";
import type { DocumentOrigin } from "./useDocumentStore";
import { moveRestorePoints, switchRestorePoints } from "./useRestorePointStore";

/**
 * 当前工程的 AI 对话：消息树（各个版本）与当前版本、记录文件、本工程的记忆（笔记、范例）、
 * 卡片的结局，以及延迟写盘。
 *
 * 放在模块级 store 里：收起对话栏（对话面板卸载）再打开，对话还在。提议卡片的结局在暂存区 store 里，
 * 这里读写盘时一并处理。
 */

/** 变化后多久写盘（毫秒）。 */
const SAVE_DELAY_MS = 1000;

interface AiChatState {
  /** 消息树（编辑重发、重新生成产生的各个版本） */
  tree: TreeItem[];
  /** 当前看的版本的最后一条 */
  headId: string | null;
  /** 当前版本的消息（由 `tree` + `headId` 得出） */
  messages: UIMessage[];
  /** 记录文件；还没保存过的工程为 `null`（只在内存里） */
  path: string | null;
  /** 对应的工程代次（`useProjectStore.generation`），面板据此重建对话 */
  generation: number;
  /** 最后使用的 AI 配置 */
  profileId: string | null;
  /** 会话序号：清空对话、换工程时加一，对话面板据此重建 */
  epoch: number;
  /** 本工程笔记 */
  notes: MemoryItem[];
  /** 本工程范例 */
  exemplars: Exemplar[];
  /** 记忆卡片的结局 */
  memoryCards: Record<string, MemoryCardOutcome>;
  /** 各素材的分析设置、标签与上传同意 */
  media: Record<string, MediaDoc>;
  /** 本工程不再询问上传 */
  uploadAlways: boolean;
  /** 忽略过的主动建议 */
  dismissedSuggestions: string[];
  /** 外部工具调用卡片的结局 */
  toolApprovals: Record<string, ToolApprovalOutcome>;
  /**
   * 修改一个素材的 AI 设置（浅合并）。
   *
   * @param mediaId 素材 id。
   * @param patch 要改的部分。
   */
  setMediaDoc: (mediaId: string, patch: Partial<MediaDoc>) => void;
  /**
   * 本工程不再询问上传。
   *
   * @param on 是否一律同意。
   */
  setUploadAlways: (on: boolean) => void;
  /**
   * 忽略一条主动建议。
   *
   * @param key 建议的键。
   */
  dismissSuggestion: (key: string) => void;
  /** 让忽略过的建议重新出现。 */
  resetSuggestions: () => void;
  /**
   * 记下外部工具调用卡片的结局。
   *
   * @param toolCallId 工具调用 id。
   * @param outcome 结局。
   */
  setToolApproval: (toolCallId: string, outcome: ToolApprovalOutcome) => void;
  /**
   * 当前版本变了（对话面板每次变化时调用）：并进消息树，并安排写盘。
   *
   * @param messages 当前版本的消息。
   * @param profileId 使用的 AI 配置。
   */
  setMessages: (messages: UIMessage[], profileId?: string | null) => void;
  /**
   * 记下记忆卡片的结局。
   *
   * @param toolCallId `remember` 工具调用的 id。
   * @param outcome 结局。
   */
  setMemoryCard: (toolCallId: string, outcome: MemoryCardOutcome) => void;
  /**
   * 添加一条本工程笔记。
   *
   * @param text 文字。
   * @returns 是否已经有同样的内容。
   */
  addNote: (text: string) => boolean;
  /**
   * 修改一条本工程笔记。
   *
   * @param id 条目 id。
   * @param patch 文字或启用状态。
   */
  updateNote: (id: string, patch: Partial<Pick<MemoryItem, "text" | "enabled">>) => void;
  /**
   * 删除一条本工程笔记。
   *
   * @param id 条目 id。
   */
  removeNote: (id: string) => void;
  /**
   * 记下一个本工程范例（同一句话只留最新的）。
   *
   * @param ex 范例。
   */
  addExemplar: (ex: Exemplar) => void;
  /**
   * 启用 / 停用一个本工程范例。
   *
   * @param id 范例 id。
   * @param enabled 是否启用。
   */
  setExemplarEnabled: (id: string, enabled: boolean) => void;
  /**
   * 删除一个本工程范例。
   *
   * @param id 范例 id。
   */
  removeExemplar: (id: string) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** 已经读入过对话的工程代次。 */
let loadedGeneration = -1;

/** 当前状态序列化成文件内容。 */
function snapshotText(): string {
  const s = useAiChatStore.getState();
  return serializeHistory({
    tree: s.tree,
    headId: s.headId,
    profileId: s.profileId,
    proposals: useAiStagingStore.getState().outcomes,
    memoryCards: s.memoryCards,
    notes: s.notes,
    exemplars: s.exemplars,
    media: s.media,
    uploadAlways: s.uploadAlways,
    dismissedSuggestions: s.dismissedSuggestions,
    toolApprovals: s.toolApprovals,
  });
}

/** 立即写盘（有记录文件时）。 */
async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const { path } = useAiChatStore.getState();
  if (!path) return;
  await aiHistoryWrite(path, snapshotText()).catch(() => undefined);
}

/** 安排写盘（合并短时间内的多次变化）。 */
function scheduleSave(): void {
  if (!useAiChatStore.getState().path) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

/** 两个消息列表是否逐条相同（同一引用）。 */
const sameList = (a: readonly UIMessage[], b: readonly UIMessage[]) => a.length === b.length && a.every((m, i) => m === b[i]);

/** 当前工程的 AI 对话。 */
export const useAiChatStore = create<AiChatState>((set, get) => {
  /** 改完记忆就写盘。 */
  const change = (patch: Partial<AiChatState>) => {
    set(patch);
    scheduleSave();
  };
  return {
    tree: [],
    headId: null,
    messages: [],
    path: null,
    generation: 0,
    profileId: null,
    epoch: 0,
    notes: [],
    exemplars: [],
    memoryCards: {},
    media: {},
    uploadAlways: false,
    dismissedSuggestions: [],
    toolApprovals: {},
    setMediaDoc: (mediaId, patch) => change({ media: { ...get().media, [mediaId]: { ...get().media[mediaId], ...patch } } }),
    setUploadAlways: (uploadAlways) => change({ uploadAlways }),
    dismissSuggestion: (key) => {
      const list = get().dismissedSuggestions;
      if (!list.includes(key)) change({ dismissedSuggestions: [...list, key].slice(-500) });
    },
    resetSuggestions: () => change({ dismissedSuggestions: [] }),
    setToolApproval: (toolCallId, outcome) => change({ toolApprovals: { ...get().toolApprovals, [toolCallId]: outcome } }),
    setMessages: (messages, profileId) => {
      const s = get();
      const profile = profileId !== undefined && profileId !== s.profileId ? { profileId } : {};
      // 面板刚挂载（尚未灌入树）或编辑第一条消息的过渡状态：不改树
      if (messages.length === 0) {
        if (s.tree.length === 0 && Object.keys(profile).length > 0) set(profile);
        return;
      }
      if (sameList(messages, s.messages) && Object.keys(profile).length === 0) return;
      change({ ...profile, tree: mergeBranch(s.tree, messages), headId: messages.at(-1)?.id ?? null, messages });
    },
    setMemoryCard: (toolCallId, outcome) => change({ memoryCards: { ...get().memoryCards, [toolCallId]: outcome } }),
    addNote: (text) => {
      const r = addMemory(get().notes, text, "n");
      change({ notes: r.list });
      return r.duplicate;
    },
    updateNote: (id, patch) => change({ notes: updateMemory(get().notes, id, patch) }),
    removeNote: (id) => change({ notes: removeMemory(get().notes, id) }),
    addExemplar: (ex) => change({ exemplars: addExemplar(get().exemplars, ex, MAX_SHOW_EXEMPLARS) }),
    setExemplarEnabled: (id, enabled) => change({ exemplars: get().exemplars.map((e) => (e.id === id ? { ...e, enabled } : e)) }),
    removeExemplar: (id) => change({ exemplars: get().exemplars.filter((e) => e.id !== id) }),
  };
});

// 提议卡片的结局变了（应用 / 放弃）：一起写盘
useAiStagingStore.subscribe((s, prev) => {
  if (s.outcomes !== prev.outcomes) scheduleSave();
});

/**
 * 换了工程：先把旧工程的对话写盘，再读入新工程的记录。
 *
 * @param generation 新工程的代次。
 * @param origin 新工程的来源。
 */
export async function switchChatDocument(generation: number, origin: DocumentOrigin): Promise<void> {
  // 离开编辑器再回来：还是同一个工程，保留内存里的对话（未保存工程的对话也不丢）
  if (loadedGeneration === generation) return;
  loadedGeneration = generation;
  void switchRestorePoints(generation, origin);
  await flush();
  const path = await historyPath(origin).catch(() => null);
  const empty = emptyChatDoc();
  useAiChatStore.setState((s) => ({
    tree: empty.tree,
    headId: null,
    messages: [],
    notes: [],
    exemplars: [],
    memoryCards: {},
    media: {},
    uploadAlways: false,
    dismissedSuggestions: [],
    toolApprovals: {},
    path,
    generation,
    profileId: null,
    epoch: s.epoch + 1,
  }));
  if (!path) return;
  const text = await aiHistoryRead(path).catch(() => null);
  // 读的过程中又换了工程：丢弃
  if (useAiChatStore.getState().generation !== generation || !text) return;
  const doc = parseHistory(text);
  useAiStagingStore.setState((s) => ({ outcomes: { ...s.outcomes, ...doc.proposals } }));
  // 读入的记录要让对话面板以它重建
  useAiChatStore.setState((s) => ({
    tree: doc.tree,
    headId: doc.headId,
    messages: currentBranch(doc.tree, doc.headId),
    notes: doc.notes,
    exemplars: doc.exemplars,
    memoryCards: doc.memoryCards,
    media: doc.media,
    uploadAlways: doc.uploadAlways,
    dismissedSuggestions: doc.dismissedSuggestions,
    toolApprovals: doc.toolApprovals,
    epoch: s.epoch + 1,
  }));
}

/**
 * 同一个工程换了保存位置（第一次保存 / 另存为）：对话与本工程的记忆跟着搬到新位置。
 *
 * @param origin 新来源。
 */
export async function moveChatDocument(origin: DocumentOrigin): Promise<void> {
  void moveRestorePoints(origin);
  const path = await historyPath(origin).catch(() => null);
  useAiChatStore.setState({ path });
  const s = useAiChatStore.getState();
  const hasData = s.tree.length > 0 || s.notes.length > 0 || s.exemplars.length > 0 || Object.keys(s.media).length > 0 || s.dismissedSuggestions.length > 0;
  if (path && hasData) await flush();
}

/**
 * 清空当前对话（文件里也清空；本工程的记忆保留）。
 *
 * @returns 清空前的对话（撤销用）。
 */
export function clearChat(): ChatBackup {
  const { tree, headId, messages, memoryCards } = useAiChatStore.getState();
  // 对话面板以 store 里的树初始化：换会话键让它重建
  useAiChatStore.setState((s) => ({ tree: [], headId: null, messages: [], memoryCards: {}, epoch: s.epoch + 1 }));
  scheduleSave();
  return { tree, headId, messages, memoryCards };
}

/** 清空前的对话（撤销“新对话”用）。 */
export interface ChatBackup {
  tree: TreeItem[];
  headId: string | null;
  messages: UIMessage[];
  memoryCards: Record<string, MemoryCardOutcome>;
}

/**
 * 恢复清空前的对话（对话面板以它重建）。
 *
 * @param backup `clearChat` 返回的备份。
 */
export function restoreChat(backup: ChatBackup): void {
  useAiChatStore.setState((s) => ({ ...backup, epoch: s.epoch + 1 }));
  scheduleSave();
}
