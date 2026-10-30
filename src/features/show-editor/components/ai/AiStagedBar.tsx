import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { expandPanel } from "../../hooks/panelControl";
import { useAiStagingStore } from "../../stores/useAiStagingStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { ChangeCounts, StagedActions } from "./AiReviewCard";

/**
 * 编辑器顶部的“AI 改动待审阅”条：对话栏收起时也看得见，可以直接应用 / 放弃，
 * 或打开对话栏看完整清单。没有暂存的改动时不渲染。
 */
export function AiStagedBar() {
  const { t } = useTranslation();
  const staged = useAiStagingStore((s) => s.staged);
  const dockOpen = useEditorUiStore((s) => !s.aiCollapsed);
  if (!staged) return null;
  return (
    <div role="region" aria-label={t("editor.ai.reviewTitle")} className="flex shrink-0 flex-wrap items-center gap-3 border-b border-primary/40 bg-primary/10 px-3 py-1.5 text-sm">
      <Bot className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="font-medium">{t("editor.ai.pending")}</span>
      <ChangeCounts changes={staged.changes} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />
      {!dockOpen && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => expandPanel("ai")}>
          {t("editor.ai.details")}
        </Button>
      )}
      <StagedActions staged={staged} compact />
    </div>
  );
}
