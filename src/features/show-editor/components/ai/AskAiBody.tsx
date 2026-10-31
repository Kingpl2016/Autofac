import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useChat, type Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Loader2, MessageSquare, SendHorizontal, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { aiErrorText, useActiveAiProfile } from "@/features/ai";
import { quickPrompts, scopeNote, scopeRange, type AskScope } from "../../ai/askScope";
import { expandPanel } from "../../hooks/panelControl";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { useAiStagingStore } from "../../stores/useAiStagingStore";
import { useAskAiStore } from "../../stores/useAskAiStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useTimelineAnalysis } from "../../stores/useMediaAnalysisStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { ChangeCounts, StagedActions } from "./AiReviewCard";
import { sendFromTimeline } from "./chatSession";

/** 回复摘要最多显示多少字。 */
const SUMMARY_CHARS = 160;

/**
 * 把范围落到编辑状态上（这一轮的上下文从编辑状态读）：片段设为选择，段落 / 时间范围设成时间范围，轨道设为选中轨道。
 *
 * @param scope 范围。
 */
function applyScope(scope: AskScope): void {
  const ui = useEditorUiStore.getState();
  const project = useProjectStore.getState().project;
  switch (scope.kind) {
    case "clips":
      ui.selectCues(scope.ids);
      break;
    case "range":
    case "section":
      ui.setTimeRange(scopeRange(scope, project));
      break;
    case "track":
      ui.selectTracks([scope.id], scope.id);
      break;
    case "point":
      if (scope.trackId) ui.selectTracks([scope.trackId], scope.trackId);
      break;
  }
}

/**
 * 发出的消息：用户的话加一句范围说明（写进消息本身，重新生成时也在）。
 *
 * @param text 用户输入。
 * @param scope 范围。
 * @param t 翻译函数。
 * @returns 消息文本。
 */
function askMessage(text: string, scope: AskScope, t: TFunction): string {
  const note = scopeNote(scope, useProjectStore.getState().project);
  return `${text.trim()}\n\n${t("editor.askAi.note", { scope: t(note.key, note.args) })}`;
}

/** 消息里的文字。 */
const textOf = (m: UIMessage) =>
  m.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** 回复：状态、摘要一行，以及去对话栏查看。 */
function AskReply({ chat, from }: { chat: Chat<UIMessage>; from: number }) {
  const { t } = useTranslation();
  const { messages, status, error } = useChat({ chat });
  const reply = messages.slice(from).findLast((m) => m.role === "assistant");
  const text = reply ? textOf(reply) : "";
  const busy = status === "submitted" || status === "streaming";
  return (
    <div className="grid gap-2 border-t border-border pt-2 text-xs" aria-live="polite">
      {busy && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          {t("editor.askAi.thinking")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {aiErrorText(t, error)}
        </p>
      )}
      {text && <p className="line-clamp-3 text-foreground">{text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text}</p>}
      <Button
        variant="link"
        size="sm"
        className="h-auto justify-self-start p-0 text-xs"
        onClick={() => {
          expandPanel("ai");
          useAskAiStore.getState().close();
        }}
      >
        <MessageSquare aria-hidden />
        {t("editor.askAi.openChat")}
      </Button>
    </div>
  );
}

/**
 * 问 AI 弹层的内容（按需加载，引入 AI SDK）：快捷建议、输入框，发出后显示回复摘要；
 * 提出的改动照常进暂存区（时间线上显示幽灵片段），这里给出应用 / 放弃。
 *
 * @param props 范围。
 */
export function AskAiBody({ scope }: { scope: AskScope }) {
  const { t, i18n } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const analysis = useTimelineAnalysis();
  const { profile, loading } = useActiveAiProfile(useAiChatStore((s) => s.profileId));
  const staged = useAiStagingStore((s) => s.staged);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ chat: Chat<UIMessage>; from: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const note = scopeNote(scope, project);
  const quick = useMemo(() => quickPrompts(scope, project, analysis), [scope, project, analysis]);

  const send = async (raw: string) => {
    if (!profile || !raw.trim() || pending) return;
    setPending(true);
    setError(null);
    applyScope(scope);
    try {
      const from = useAiChatStore.getState().messages.length;
      const chat = await sendFromTimeline(askMessage(raw, scope, t), profile, i18n.language, t);
      setSent({ chat, from });
      setText("");
    } catch (e: unknown) {
      setError(aiErrorText(t, e));
    } finally {
      setPending(false);
    }
  };

  // 带着话打开（“让 AI 细化”建议）：配置就绪后直接发出一次
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (loading || !profile) return;
    const prompt = useAskAiStore.getState().takePrompt();
    if (prompt) void sendRef.current(prompt);
  }, [loading, profile]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label={t("common.loading")} />;

  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t(note.key, note.args)}</span>
      </p>
      {!profile ? (
        <p className="text-xs text-muted-foreground">{t("ai.errors.no_profile")}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("editor.askAi.quickLabel")}>
            {quick.map((q) => (
              <Button key={q.key} variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={() => void send(String(t(q.key, q.args)))}>
                {t(q.key, q.args)}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-1.5">
            <Textarea
              autoFocus
              rows={2}
              value={text}
              aria-label={t("editor.askAi.inputLabel")}
              placeholder={t("editor.askAi.placeholder")}
              className="min-h-0 resize-none text-xs"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <Button size="icon" className="size-8 shrink-0" aria-label={t("editor.askAi.send")} disabled={pending || !text.trim()} onClick={() => void send(text)}>
              {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <SendHorizontal aria-hidden />}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {sent && <AskReply chat={sent.chat} from={sent.from} />}
      {sent && staged && (
        <div className="grid gap-1.5 rounded-md border border-primary/40 bg-primary/10 p-2">
          <ChangeCounts changes={staged.changes} className="text-xs" />
          <StagedActions staged={staged} compact />
        </div>
      )}
    </div>
  );
}
