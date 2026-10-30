import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bot, Brain, Loader2, SquarePen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useActiveAiProfile } from "@/features/ai";
import { cn } from "@/lib/utils";
import { collapsePanel } from "../../hooks/panelControl";
import { clearChat, useAiChatStore } from "../../stores/useAiChatStore";
import { useAiStagingStore } from "../../stores/useAiStagingStore";
import { AiMemoryPage } from "./AiMemoryPage";
import { AiReviewCard } from "./AiReviewCard";

/** 对话界面引入 AI SDK 与 assistant-ui，按需加载。 */
const AiChatPanel = lazy(() => import("./AiChatPanel").then((m) => ({ default: m.AiChatPanel })));

/**
 * 右侧 AI 对话栏：标题栏（记忆、新对话、收起）、待审阅的改动（审阅卡片），以及对话或记忆页。
 * 没有 AI 配置时引导去设置页添加。
 */
export function AiDock() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profile, loading } = useActiveAiProfile(useAiChatStore((s) => s.profileId));
  const staged = useAiStagingStore((s) => s.staged);
  const epoch = useAiChatStore((s) => s.epoch);
  const hasMessages = useAiChatStore((s) => s.messages.length > 0);
  // 记忆页与对话切换显示；对话保持挂载（正在生成的回复不中断）
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <section aria-label={t("editor.ai.dockTitle")} className="flex h-full min-h-0 flex-col border-l border-border bg-surface-2">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Bot className="ml-1 size-4 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t(memoryOpen ? "editor.ai.memory.title" : "editor.ai.dockTitle")}</h2>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", memoryOpen && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary")}
          aria-label={t("editor.ai.memory.title")}
          title={t("editor.ai.memory.title")}
          aria-pressed={memoryOpen}
          data-tour="ai-memory"
          onClick={() => setMemoryOpen((v) => !v)}
        >
          <Brain aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.ai.newChat")}
          title={t("editor.ai.newChat")}
          disabled={!hasMessages}
          onClick={clearChat}
        >
          <SquarePen aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.ai.closeDock")}
          title={`${t("editor.ai.closeDock")} (Ctrl+J)`}
          onClick={() => collapsePanel("ai")}
        >
          <X aria-hidden />
        </Button>
      </header>
      {staged && (
        <div className="shrink-0 border-b border-border p-3">
          <AiReviewCard staged={staged} />
        </div>
      )}
      {memoryOpen && <AiMemoryPage />}
      <div className={cn("flex min-h-0 flex-1 flex-col", memoryOpen && "hidden")}>
        {loading ? null : !profile ? (
          <div className="grid gap-2 p-4 text-sm">
            <p className="text-muted-foreground">{t("ai.errors.no_profile")}</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/settings#ai")}>
              {t("editor.ai.openSettings")}
            </Button>
          </div>
        ) : (
          <Suspense fallback={<Loader2 className="m-4 size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}>
            <AiChatPanel profile={profile} session={epoch} />
          </Suspense>
        )}
      </div>
    </section>
  );
}
