import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Check, ChevronDown, CircleSlash, Loader2, Plug, ShieldAlert, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MCP_PREFIX, useAiPrefsStore } from "@/features/ai";
import { cn } from "@/lib/utils";
import { useAiChatStore } from "../../../stores/useAiChatStore";

/** 外部工具结果（见 `ai/mcpTools.ts`）。 */
export interface ExternalResult {
  text?: string;
  isError?: boolean;
  truncated?: boolean;
  source?: string;
}

/** `mcp__服务器__工具` → 服务器、工具。 */
function splitName(name: string): { server: string; tool: string } {
  const rest = name.slice(MCP_PREFIX.length);
  const at = rest.indexOf("__");
  return at < 0 ? { server: "?", tool: rest } : { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** 参数的文字（截断）。 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 外部（MCP）工具调用卡片：调用前显示服务器、工具与完整参数，由用户允许 / 总是允许 / 拒绝；
 * 调用后可以展开看结果（标明来自外部，是不可信数据）。结局随对话记录保存。
 */
export function ExternalToolCard({ toolCallId, toolName, argsText, result, status, approval, respondToApproval }: ToolCallMessagePartProps<unknown, ExternalResult>) {
  const { t } = useTranslation();
  const outcome = useAiChatStore((s) => s.toolApprovals[toolCallId]);
  const [busy, setBusy] = useState(false);
  const { server, tool } = splitName(toolName);
  const waiting = !!approval && approval.approved === undefined && !approval.resolution;
  const denied = approval?.approved === false || outcome === "denied";

  const decide = async (choice: "allowed" | "always" | "denied") => {
    setBusy(true);
    try {
      if (choice === "always") useAiPrefsStore.getState().setMcpAlwaysAllow(toolName, true);
      await respondToApproval({ approved: choice !== "denied", ...(choice === "denied" ? { reason: "The user denied this call." } : {}) });
      useAiChatStore.getState().setToolApproval(toolCallId, choice);
    } finally {
      setBusy(false);
    }
  };

  const running = status.type === "running" && !waiting;
  const Icon = running ? Loader2 : denied ? CircleSlash : Plug;
  return (
    <div data-external-tool className={cn("my-2 grid gap-1.5 rounded-lg border p-2.5", waiting ? "border-warning/60 bg-warning/5" : "border-border bg-muted/30")}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className={cn("size-3.5 shrink-0 text-primary", running && "animate-spin motion-reduce:animate-none")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("editor.ai.external.title", { server, tool })}</span>
        {(outcome || denied) && (
          <Badge variant={denied ? "secondary" : "success"}>
            {!denied && <Check className="size-3" aria-hidden />}
            {t(`editor.ai.external.outcomes.${denied ? "denied" : (outcome ?? "allowed")}`)}
          </Badge>
        )}
      </div>
      {argsText && argsText !== "{}" && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 font-mono text-[11px] text-muted-foreground">{clip(argsText, 4000)}</pre>
      )}
      {waiting && (
        <>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            {t("editor.ai.external.ask")}
          </p>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => void decide("denied")}>
              <X aria-hidden />
              {t("editor.ai.external.deny")}
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} title={t("editor.ai.external.alwaysHint")} onClick={() => void decide("always")}>
              {t("editor.ai.external.always")}
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => void decide("allowed")}>
              <Check aria-hidden />
              {t("editor.ai.external.allow")}
            </Button>
          </div>
        </>
      )}
      {result !== undefined && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {result.isError ? t("editor.ai.external.resultError") : t("editor.ai.external.result")}
            {result.truncated && <span>· {t("editor.ai.external.truncated")}</span>}
            <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("editor.ai.external.untrusted")}</p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 p-2 font-mono text-[11px]">
              {clip(typeof result === "string" ? result : (result.text ?? JSON.stringify(result)), 4000)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
