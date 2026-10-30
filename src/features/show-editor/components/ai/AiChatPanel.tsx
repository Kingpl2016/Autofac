import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useChat } from "@ai-sdk/react";
import { DirectChatTransport, type ChatTransport, type UIMessage } from "ai";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { Loader2 } from "lucide-react";

import { aiErrorText, loadLanguageModel, useAiPrefsStore, type AiProfileView, type LoadedModel } from "@/features/ai";
import { offerChange } from "../../ai/actions";
import { editorSnapshot, ensureLibraries, memorySnapshot } from "../../ai/env";
import type { MemoryRef, ReplyMetadata } from "../../ai/memory";
import { createShowAgent, type Proposal } from "../../ai/runtime";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { makeStaged, useAiStagingStore } from "../../stores/useAiStagingStore";
import { Thread } from "./thread/Thread";

/**
 * AI 对话（按需加载，引入 AI SDK 与 assistant-ui）。
 *
 * `useChat`（经 `DirectChatTransport` 在进程内运行智能体）→ `useAISDKRuntime` → assistant-ui 的 `Thread`。
 * 模型经只读工具查询工程，经 `propose_ops` 提交改动；改动试运行通过后进入暂存区，
 * 开了自动写入且不敏感时直接写入。消息树（编辑重发、重新生成的各个版本）在会话开始时经
 * `messageRepository` 灌入，当前版本的变化写回 `useAiChatStore`，跟着工程保存。
 * 每一轮带上记忆，用到的记忆挂在回复的元数据上。
 */

/** 工具调用的结局（压缩较早的轮次时写进摘要行）。 */
const outcomeOf = (toolCallId: string) => useAiStagingStore.getState().outcomes[toolCallId] ?? useAiChatStore.getState().memoryCards[toolCallId];

/**
 * 创建对话的传输层：进程内运行的智能体，提议交给暂存区，每轮用到的记忆挂到回复的元数据上。
 *
 * @param loaded 已加载的模型。
 * @param lang 界面语言。
 * @param t 翻译函数。
 * @returns 交给 `useChat` 的传输层。
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
    if (staged) offerChange(staged, useAiPrefsStore.getState().autoApply, t);
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
  });
  // 消息按通用的 UIMessage 处理（工具部件按名字渲染），不需要按工具推导的精确类型
  return new DirectChatTransport({
    agent,
    messageMetadata: ({ part }): ReplyMetadata | undefined => (part.type === "start" ? { memory: used } : undefined),
  }) as unknown as ChatTransport<UIMessage>;
}

/** 一个对话会话（模型已加载）。换配置、清空对话、换工程时由外层按键重建。 */
function ChatSession({ loaded }: { loaded: LoadedModel }) {
  const { t, i18n } = useTranslation();
  // 整棵消息树（各个版本）只在会话开始时灌入一次；之后以 useChat 为准，变化写回 store
  const repository = useMemo(() => {
    const { tree, headId } = useAiChatStore.getState();
    return tree.length > 0 ? { headId, messages: tree } : undefined;
  }, []);

  const transport = useMemo(() => createTransport(loaded, i18n.language, t), [loaded, i18n.language, t]);

  const chat = useChat({ transport });
  const suggestions = useMemo(
    () => (["selection", "chorus", "explain"] as const).map((k) => ({ prompt: t(`editor.ai.suggest.${k}`) })),
    [t],
  );
  const runtime = useAISDKRuntime(chat, { suggestions, messageRepository: repository });

  // 词汇表（特效库、模板库、灯具素材库）与记忆在第一次请求前读入
  useEffect(() => {
    void ensureLibraries();
  }, []);
  // 当前版本写回 store（并进消息树；关掉对话栏再打开还在，并按工程写盘）
  const { messages } = chat;
  useEffect(() => {
    useAiChatStore.getState().setMessages(messages, loaded.profile.id);
  }, [messages, loaded.profile.id]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

/**
 * 对话面板：加载所选配置的模型后开始会话；换配置、清空对话或换工程时重建会话（消息从 store 继承）。
 *
 * @param props 使用的 AI 配置与会话序号（`useAiChatStore.epoch`）。
 */
export function AiChatPanel({ profile, session }: { profile: AiProfileView; session: number }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ id: string; model: LoadedModel } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadLanguageModel(profile)
      .then((model) => alive && setLoaded({ id: profile.id, model }))
      .catch((e: unknown) => alive && setError(aiErrorText(t, e)));
    return () => {
      alive = false;
    };
  }, [profile, t]);

  if (error) {
    return (
      <p role="alert" className="p-4 text-xs text-destructive">
        {error}
      </p>
    );
  }
  if (!loaded || loaded.id !== profile.id) {
    return <Loader2 className="m-4 size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label={t("common.loading")} />;
  }
  return <ChatSession key={`${session}-${profile.id}-${profile.model}`} loaded={loaded.model} />;
}
