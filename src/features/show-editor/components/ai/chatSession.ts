import { Chat } from "@ai-sdk/react";
import { DirectChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type ChatTransport, type UIMessage } from "ai";
import type { TFunction } from "i18next";

import { enabledSkills, loadLanguageModel, mcpCallTool, mcpToolSpecs, useAiPrefsStore, type AiProfileView, type LoadedModel } from "@/features/ai";
import { buildMcpTools } from "../../ai/mcpTools";
import { userSkillOf, type UserSkill } from "../../ai/skills";
import { offerChange } from "../../ai/actions";
import { editorSnapshot, ensureLibraries, memorySnapshot } from "../../ai/env";
import type { MemoryRef, ReplyMetadata } from "../../ai/memory";
import { createShowAgent, type Proposal } from "../../ai/runtime";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { makeStaged, useAiStagingStore } from "../../stores/useAiStagingStore";
import { ensurePrimaryAnalysis } from "../../stores/useMediaAnalysisStore";

/**
 * 共用的对话会话（按需加载，引入 AI SDK）：对话栏与时间线上的“问 AI”用同一个 AI SDK `Chat`，
 * 所以对话栏收起时也能在时间线上提问，消息照常进对话记录。
 *
 * 会话按“会话序号 + 配置 + 模型”区分：清空对话、换工程（序号变化）或换配置时新建；
 * 同一个键反复取得到同一个 `Chat`（对话栏卸载再挂载、问 AI 弹层关了再开都不丢进行中的回复）。
 */

/** 启用的用户技能（格式不对的跳过）。 */
const userSkillsSnapshot = (): UserSkill[] => enabledSkills().flatMap(({ text }) => userSkillOf(text) ?? []);

/** 工具调用的结局（压缩较早的轮次时写进摘要行）。 */
const outcomeOf = (toolCallId: string) =>
  useAiStagingStore.getState().outcomes[toolCallId] ?? useAiChatStore.getState().memoryCards[toolCallId] ?? useAiChatStore.getState().toolApprovals[toolCallId];

/**
 * 创建对话的传输层：进程内运行的智能体，提议交给暂存区，每轮用到的记忆挂到回复的元数据上。
 *
 * @param loaded 已加载的模型。
 * @param lang 界面语言。
 * @param t 翻译函数。
 * @returns 交给 `Chat` 的传输层。
 */
function createTransport(loaded: LoadedModel, lang: string, t: TFunction): ChatTransport<UIMessage> {
  const onProposal = ({ ops, snapshot, toolCallId, request }: Proposal) => {
    const staged = makeStaged({
      summary: ops.summary,
      ops: ops.ops,
      base: snapshot.project,
      aliases: snapshot.aliases,
      env: snapshot.env,
      source: "chat",
      sourceId: toolCallId,
      request,
    });
    if (staged) offerChange(staged, useAiPrefsStore.getState().autoApply, t, { reveal: !quiet });
  };
  // 本轮用到的记忆：prepareCall 里记下，回复开始时挂到回复的元数据上
  let used: MemoryRef[] = [];
  const agent = createShowAgent({
    loaded,
    snapshot: () => editorSnapshot(lang),
    onProposal,
    memory: memorySnapshot,
    outcomeOf,
    onTurn: (info) => {
      used = info.memory;
    },
    userSkills: userSkillsSnapshot,
    analyze: ensurePrimaryAnalysis,
    externalTools: () => buildMcpTools(mcpToolSpecs(), mcpCallTool, (name) => useAiPrefsStore.getState().mcpAlwaysAllow.includes(name)),
  });
  // 消息按通用的 UIMessage 处理（工具部件按名字渲染），不需要按工具推导的精确类型
  return new DirectChatTransport({
    agent,
    messageMetadata: ({ part }): ReplyMetadata | undefined => {
      if (part.type === "start") return { memory: used };
      // 每一步结束时记下这一步的用量（后一步覆盖前一步）：最后一步的输入 + 输出就是对话此刻占用的上下文
      if (part.type === "finish-step" && part.usage.inputTokens !== undefined) {
        return { context: { input: part.usage.inputTokens, output: part.usage.outputTokens ?? 0 } };
      }
      return undefined;
    },
  }) as unknown as ChatTransport<UIMessage>;
}

/** 正在进行的是从时间线发起的一轮（提议不打开对话栏）。 */
let quiet = false;

/** 当前的会话。 */
let current: { key: string; chat: Chat<UIMessage>; profileId: string } | null = null;

/**
 * 会话的键。
 *
 * @param session 会话序号（`useAiChatStore.epoch`）。
 * @param profile AI 配置。
 * @param lang 界面语言。
 * @returns 键。
 */
export const sessionKey = (session: number, profile: Pick<AiProfileView, "id" | "model">, lang: string) => `${session}|${profile.id}|${profile.model}|${lang}`;

/**
 * 取得（需要时新建）会话。
 *
 * @param key 会话的键（`sessionKey`）。
 * @param loaded 已加载的模型。
 * @param lang 界面语言。
 * @param t 翻译函数。
 * @returns 会话。
 */
export function chatFor(key: string, loaded: LoadedModel, lang: string, t: TFunction): Chat<UIMessage> {
  if (current?.key === key) return current.chat;
  current?.chat.stop().catch(() => undefined);
  const chat = new Chat<UIMessage>({
    transport: createTransport(loaded, lang, t),
    // 外部工具的调用确认之后自动继续
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  current = { key, chat, profileId: loaded.profile.id };
  return chat;
}

/**
 * 会话没在生成时清空消息（对话栏挂载时由整棵消息树重建，各个版本都在）。
 *
 * @param chat 会话。
 */
export function clearIdle(chat: Chat<UIMessage>): void {
  if (chat.status === "ready" || chat.status === "error") chat.messages = [];
}

/**
 * 在共用会话里发一条消息（对话栏没打开时也能用）：需要时加载模型、建会话，消息照常写回对话记录。
 *
 * @param text 消息。
 * @param profile AI 配置。
 * @param lang 界面语言。
 * @param t 翻译函数。
 * @returns 会话（调用方可订阅它的状态）。
 */
export async function sendFromTimeline(text: string, profile: AiProfileView, lang: string, t: TFunction): Promise<Chat<UIMessage>> {
  const key = sessionKey(useAiChatStore.getState().epoch, profile, lang);
  let chat = current?.key === key ? current.chat : null;
  if (!chat) {
    const loaded = await loadLanguageModel(profile);
    chat = chatFor(key, loaded, lang, t);
    // 新会话：从对话记录接上当前版本（对话栏打开时会从整棵树重建）
    if (chat.messages.length === 0) chat.messages = useAiChatStore.getState().messages;
  }
  await ensureLibraries();
  quiet = true;
  const done = chat.sendMessage({ text }).finally(() => {
    quiet = false;
  });
  // 消息写回对话记录（对话栏没挂载时由这里负责）
  const sync = () => useAiChatStore.getState().setMessages(chat.messages, profile.id);
  void done.finally(sync);
  return chat;
}

/** 测试用：丢掉当前会话。 */
export function resetChatSession(): void {
  current = null;
}
