import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "@ai-sdk/react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { Loader2 } from "lucide-react";

import { aiErrorText, loadLanguageModel, type AiProfileView, type LoadedModel } from "@/features/ai";
import { ensureLibraries } from "../../ai/env";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { chatFor, clearIdle, sessionKey } from "./chatSession";
import { Thread } from "./thread/Thread";

/**
 * AI 对话（按需加载，引入 AI SDK 与 assistant-ui）。
 *
 * 共用会话（`chatSession.ts`，与时间线上的“问 AI”是同一个 AI SDK `Chat`）→ `useChat` → `useAISDKRuntime`
 * → assistant-ui 的 `Thread`。模型经只读工具查询工程，经 `propose_ops` 提交改动；改动试运行通过后进入暂存区，
 * 开了自动写入且不敏感时直接写入。消息树（编辑重发、重新生成的各个版本）在挂载时经 `messageRepository`
 * 灌入，当前版本的变化写回 `useAiChatStore`，跟着工程保存。每一轮带上记忆，用到的记忆挂在回复的元数据上。
 */

/** 一个对话会话（模型已加载）。换配置、清空对话、换工程时由外层按键重建。 */
function ChatSession({ loaded, sessionId }: { loaded: LoadedModel; sessionId: string }) {
  const { t, i18n } = useTranslation();
  // 与时间线“问 AI”共用的会话
  const shared = useMemo(() => chatFor(sessionId, loaded, i18n.language, t), [sessionId, loaded, i18n.language, t]);
  // 整棵消息树（各个版本）只在挂载时灌入一次；之后以 useChat 为准，变化写回 store。
  // 会话里已有消息（时间线上问过）且没在生成时，先清空，由树重建，保证各个版本都在
  const repository = useMemo(() => {
    const { tree, headId } = useAiChatStore.getState();
    if (tree.length === 0) return undefined;
    clearIdle(shared);
    return { headId, messages: tree };
  }, [shared]);

  const chat = useChat({ chat: shared });
  const suggestions = useMemo(
    () => (["selection", "chorus", "explain"] as const).map((k) => ({ prompt: t(`editor.ai.suggest.${k}`) })),
    [t],
  );
  const runtime = useAISDKRuntime(chat, { suggestions, messageRepository: repository });

  // 词汇表（特效库、模板库、灯具素材库）、记忆与音乐分析在第一次请求前读入
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
  const { t, i18n } = useTranslation();
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
  const sessionId = sessionKey(session, profile, i18n.language);
  return <ChatSession key={sessionId} sessionId={sessionId} loaded={loaded.model} />;
}
