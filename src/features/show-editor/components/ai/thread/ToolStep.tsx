import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { AlertTriangle, Brain, Check, ChevronDown, CircleSlash, Loader2, Sparkles, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAiMemoryStore } from "@/features/ai";
import { cn } from "@/lib/utils";
import type { RememberInput } from "../../../ai/runtime";
import { useAiChatStore } from "../../../stores/useAiChatStore";
import { useAiStagingStore } from "../../../stores/useAiStagingStore";
import { ChangeCounts, StagedActions } from "../AiReviewCard";

/** 工具名 → 文案键。 */
const TOOL_KEYS: Record<string, string> = {
  list_cues: "listCues",
  get_cue: "getCue",
  list_effects: "listEffects",
  list_templates: "listTemplates",
  list_recipes: "listRecipes",
  list_fixture_models: "listModels",
  get_output: "getOutput",
};

/** 结果的文字形式（截断）。 */
function resultText(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/**
 * 一个只读工具调用：可展开的步骤行（图标、名称、状态），展开后看参数与结果。
 */
function ToolStep({ toolName, argsText, result, status }: ToolCallMessagePartProps) {
  const { t } = useTranslation();
  const running = status.type === "running";
  const failed = status.type === "incomplete";
  const Icon = running ? Loader2 : failed ? CircleSlash : Wrench;
  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className="group flex max-w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className={cn("size-3.5 shrink-0", running && "animate-spin motion-reduce:animate-none")} aria-hidden />
        <span className="truncate">{t(`editor.ai.tools.${TOOL_KEYS[toolName] ?? "other"}`)}</span>
        {failed && <span className="text-destructive">· {t("editor.ai.tools.failed")}</span>}
        <ChevronDown className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
        {argsText && argsText !== "{}" && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground">{argsText}</pre>}
        {result !== undefined && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{resultText(result)}</pre>}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** `propose_ops` 的参数与结果（只取界面用到的字段）。 */
interface ProposalArgs {
  summary?: string;
  ops?: unknown[];
}
interface ProposalResult {
  ok?: boolean;
  errors?: string;
  warnings?: string;
}

/**
 * `propose_ops` 的内联卡片：模型的说明与改动计数。就是当前待审阅的那份时可以直接预览 / 应用 / 放弃；
 * 已处理过的标出结局；校验失败（模型正在修正）时显示问题。
 */
function ProposalCard({ toolCallId, args, result, status }: ToolCallMessagePartProps<ProposalArgs, ProposalResult>) {
  const { t } = useTranslation();
  const staged = useAiStagingStore((s) => (s.staged?.sourceId === toolCallId ? s.staged : null));
  const outcome = useAiStagingStore((s) => s.outcomes[toolCallId]);
  if (status.type === "running" || result === undefined) {
    return (
      <p role="status" className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        {t("editor.ai.tools.proposeOps")}
      </p>
    );
  }
  if (!result.ok) {
    return (
      <Collapsible className="my-1">
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <AlertTriangle className="size-3.5" aria-hidden />
          {t("editor.ai.tools.retrying")}
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px]">{result.errors}</pre>
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <div className="my-2 grid gap-1.5 rounded-lg border border-primary/40 bg-primary/5 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">{t("editor.ai.proposal")}</span>
        {outcome && (
          <Badge variant={outcome === "applied" ? "success" : "secondary"}>
            {outcome === "applied" && <Check className="size-3" aria-hidden />}
            {t(`editor.ai.outcomes.${outcome}`)}
          </Badge>
        )}
      </div>
      {args.summary && <p className="text-sm">{args.summary}</p>}
      {staged ? (
        <>
          <ChangeCounts changes={staged.changes} className="text-xs text-muted-foreground" />
          <StagedActions staged={staged} compact />
        </>
      ) : (
        !outcome && <p className="text-xs text-muted-foreground">{t("editor.ai.notPending")}</p>
      )}
    </div>
  );
}

/**
 * `remember` 的记忆卡片：模型提出要记住的一句话与范围（个人偏好 / 本工程），用户点“保存”才写入；
 * 结局随对话记录保存。同样的内容不重复存。
 */
function MemoryCard({ toolCallId, args, status }: ToolCallMessagePartProps<Partial<RememberInput>, unknown>) {
  const { t } = useTranslation();
  const outcome = useAiChatStore((s) => s.memoryCards[toolCallId]);
  const [duplicate, setDuplicate] = useState(false);
  const text = args.text?.trim() ?? "";
  if (status.type === "running" || !text) {
    return (
      <p role="status" className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        {t("editor.ai.memoryCard.preparing")}
      </p>
    );
  }
  const show = args.scope === "show";
  const decide = (save: boolean) => {
    const chat = useAiChatStore.getState();
    if (save) setDuplicate(show ? chat.addNote(text) : useAiMemoryStore.getState().add(text));
    chat.setMemoryCard(toolCallId, save ? "saved" : "ignored");
  };
  return (
    <div data-memory-card className="my-2 grid gap-1.5 rounded-lg border border-border bg-muted/30 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Brain className="size-3.5 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">{t("editor.ai.memoryCard.title")}</span>
        <Badge variant="outline">{t(show ? "editor.ai.memory.kinds.note" : "editor.ai.memory.kinds.pref")}</Badge>
        {outcome && (
          <Badge variant={outcome === "saved" ? "success" : "secondary"}>
            {outcome === "saved" && <Check className="size-3" aria-hidden />}
            {t(`editor.ai.memoryCard.${outcome}`)}
          </Badge>
        )}
      </div>
      <p className="text-sm">{text}</p>
      {!outcome && (
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => decide(false)}>
            {t("editor.ai.memoryCard.ignore")}
          </Button>
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => decide(true)}>
            {t("editor.ai.memoryCard.save")}
          </Button>
        </div>
      )}
      {duplicate && <p className="text-xs text-muted-foreground">{t("ai.memory.duplicate")}</p>}
    </div>
  );
}

/**
 * 助手消息里的工具调用：`propose_ops` 显示成提议卡片，`remember` 显示成记忆卡片，其它显示成可展开的步骤行。
 */
export function ToolCallPart(props: ToolCallMessagePartProps) {
  if (props.toolName === "propose_ops") return <ProposalCard {...(props as ToolCallMessagePartProps<ProposalArgs, ProposalResult>)} />;
  if (props.toolName === "remember") return <MemoryCard {...(props as ToolCallMessagePartProps<Partial<RememberInput>, unknown>)} />;
  return <ToolStep {...props} />;
}
