import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { useAuiState } from "@assistant-ui/react";
import { Brain, ChevronDown, Eye, EyeOff, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { MemoryRef, ReplyMetadata } from "../../../ai/memory";
import { removeMemoryRef, resolveMemory, setMemoryEnabled, useMemoryState } from "../memoryRefs";
import { TooltipIconButton } from "./TooltipIconButton";

const EMPTY: MemoryRef[] = [];

/**
 * 回复下方的“参考了 N 条记忆”：展开后列出这一轮放进提示词的记忆，可以直接停用或删除
 * （停用的不再放进之后的提示词，对应 ChatGPT 的“不要再提”）。没有用到记忆时不显示。
 */
export const MemorySources: FC = () => {
  const { t } = useTranslation();
  const refs = useAuiState((s) => (s.message.metadata.custom as ReplyMetadata | undefined)?.memory) ?? EMPTY;
  const state = useMemoryState();
  if (refs.length === 0) return null;
  const items = refs.map((r) => resolveMemory(state, r));
  return (
    <Collapsible className="w-full">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Brain className="size-3.5" aria-hidden />
        {t("editor.ai.memory.sources", { count: refs.length })}
        <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 grid gap-1 rounded-md border border-border bg-muted/30 p-2">
          {items.map((m) => (
            <li key={`${m.ref.kind}-${m.ref.id}`} className="flex items-center gap-1.5 text-xs">
              <Badge variant="outline" className="shrink-0">
                {t(`editor.ai.memory.kinds.${m.ref.kind}`)}
              </Badge>
              {m.text === null ? (
                <span className="flex-1 text-muted-foreground">{t("editor.ai.memory.deleted")}</span>
              ) : (
                <>
                  <span className={cn("min-w-0 flex-1 break-words", !m.enabled && "text-muted-foreground line-through")}>{m.text}</span>
                  <TooltipIconButton
                    tooltip={t(m.enabled ? "editor.ai.memory.disable" : "editor.ai.memory.enable")}
                    onClick={() => setMemoryEnabled(m.ref, !m.enabled)}
                  >
                    {m.enabled ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </TooltipIconButton>
                  <TooltipIconButton tooltip={t("editor.ai.memory.remove")} onClick={() => removeMemoryRef(m.ref)}>
                    <Trash2 aria-hidden />
                  </TooltipIconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
};
