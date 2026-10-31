import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { useAuiState } from "@assistant-ui/react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { contextWindowOf, useActiveAiProfile } from "@/features/ai";
import { cn } from "@/lib/utils";
import type { ReplyMetadata } from "../../../ai/memory";
import { useAiChatStore } from "../../../stores/useAiChatStore";

/** 用量到这个比例时提示快满了。 */
const WARN_RATIO = 0.7;
/** 用量到这个比例时标红。 */
const FULL_RATIO = 0.9;

/**
 * token 数的简短写法（`850`、`12.3k`、`128k`、`1.0M`）。
 *
 * @param n tokens。
 * @returns 文字。
 */
function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 当前版本里最后一条带用量的回复的用量（没有时为 `null`）。 */
function useLastUsage(): { input: number; output: number } | null {
  const input = useAuiState((s) => lastContext(s.thread.messages)?.input ?? -1);
  const output = useAuiState((s) => lastContext(s.thread.messages)?.output ?? 0);
  return input < 0 ? null : { input, output };
}

/** 从后往前找带用量的助手消息。 */
function lastContext(messages: readonly { role: string; metadata: { custom: Record<string, unknown> } }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const ctx = (m.metadata.custom as ReplyMetadata | undefined)?.context;
    if (ctx) return ctx;
  }
  return null;
}

/** 小圆环：已用比例。 */
const Ring: FC<{ ratio: number }> = ({ ratio }) => {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, ratio))} strokeLinecap="round" />
    </svg>
  );
};

/**
 * 输入框底部的上下文用量：最近一次模型调用占用的 tokens（输入 + 输出）/ 当前模型的上下文上限，
 * 悬停显示明细。不认识的模型只显示已用量；还没有回复时显示 0。较早的轮次发送前会被压缩，所以长对话的用量不会一直涨。
 */
export const ContextMeter: FC = () => {
  const { t } = useTranslation();
  const { profile } = useActiveAiProfile(useAiChatStore((s) => s.profileId));
  const usage = useLastUsage();
  const total = profile ? contextWindowOf(profile.model) : null;
  const used = usage ? usage.input + usage.output : 0;
  const ratio = total ? used / total : 0;
  const percent = total ? Math.min(100, ratio * 100).toFixed(ratio < 0.1 ? 1 : 0) : null;
  const label = total ? t("editor.ai.context.label", { used: formatTokens(used), total: formatTokens(total) }) : t("editor.ai.context.labelUnknown", { used: formatTokens(used) });
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={label}
            data-testid="ai-context-meter"
            className={cn(
              "inline-flex h-7 cursor-default items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ratio >= FULL_RATIO ? "text-destructive" : ratio >= WARN_RATIO && "text-warning",
            )}
          >
            <Ring ratio={ratio} />
            <span>{total ? `${formatTokens(used)} / ${formatTokens(total)}` : formatTokens(used)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="grid max-w-64 gap-1 text-xs">
          <span className="font-medium">{t("editor.ai.context.title")}</span>
          {!usage ? (
            <span>{t("editor.ai.context.empty")}</span>
          ) : (
            <>
              <span>
                {total
                  ? t("editor.ai.context.detail", { used: used.toLocaleString(), total: total.toLocaleString(), percent })
                  : t("editor.ai.context.detailUnknown", { used: used.toLocaleString() })}
              </span>
              <span className="opacity-80">{t("editor.ai.context.breakdown", { input: usage.input.toLocaleString(), output: usage.output.toLocaleString() })}</span>
            </>
          )}
          {profile && <span className="opacity-80">{t("editor.ai.context.model", { model: profile.model })}</span>}
          {ratio >= WARN_RATIO && <span>{t("editor.ai.context.full")}</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
