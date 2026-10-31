import { useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import type { RestorePoint } from "../ai/restorePoints";
import { useProjectStore } from "../stores/useProjectStore";
import { reapplyRestorePoint, restoreBeforePoint, revertRestorePoint, useRestorePointStore } from "../stores/useRestorePointStore";

/** 一个还原点的行。 */
function PointRow({ point, latest }: { point: RestorePoint; latest: boolean }) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const time = new Date(point.at).toLocaleString(i18n.language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const undo = { label: t("editor.ai.undo"), onClick: () => useProjectStore.temporal.getState().undo() };
  const report = (r: { applied: number; skipped: number } | null, key: string) => {
    if (!r) return;
    const text = r.skipped > 0 ? t(`editor.aiHistory.${key}Partial`, { skipped: r.skipped }) : t(`editor.aiHistory.${key}Done`);
    announce(text);
    (r.skipped > 0 ? toast.warning : toast.success)(text, { action: undo });
  };
  const applied = point.state === "applied";
  return (
    <li className="grid gap-1 rounded-md border border-border p-2 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium" title={point.summary}>
          {point.summary || t(`editor.aiHistory.sources.${point.source}`)}
        </span>
        <Badge variant={applied ? "secondary" : "outline"}>{t(applied ? "editor.aiHistory.applied" : "editor.aiHistory.reverted")}</Badge>
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span>{time}</span>
        <span>·</span>
        <span>{t(`editor.aiHistory.sources.${point.source}`)}</span>
        {point.cueCount > 0 && <span>· {t("editor.aiHistory.cues", { count: point.cueCount })}</span>}
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {applied ? (
          <>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title={t("editor.aiHistory.revertHint")} onClick={() => report(revertRestorePoint(point.id), "revert")}>
              <Undo2 aria-hidden />
              {t("editor.aiHistory.revert")}
            </Button>
            {!latest && (
              <Button
                variant={confirming ? "destructive" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                title={t("editor.aiHistory.restoreHint")}
                onBlur={() => setConfirming(false)}
                onClick={() => {
                  if (!confirming) return setConfirming(true);
                  setConfirming(false);
                  report(restoreBeforePoint(point.id), "restore");
                }}
              >
                <RotateCcw aria-hidden />
                {t(confirming ? "editor.aiHistory.restoreConfirm" : "editor.aiHistory.restore")}
              </Button>
            )}
          </>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => report(reapplyRestorePoint(point.id), "reapply")}>
            <Redo2 aria-hidden />
            {t("editor.aiHistory.reapply")}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * 时间线工具条的“AI 历史”：每次写入的 AI 改动（对话、草稿、建议）都是一个还原点，
 * 可以只撤回某一次（之后手动改过的部分保留）、恢复到某次之前，或把撤回的重新应用。都是一步撤销。
 */
export function AiHistoryMenu() {
  const { t } = useTranslation();
  const points = useRestorePointStore((s) => s.points);
  const list = [...points].reverse();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-tour="ai-history"
          className={cn("size-6", points.length === 0 && "text-muted-foreground")}
          aria-label={t("editor.aiHistory.title")}
          title={t("editor.aiHistory.title")}
        >
          <History aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-2 p-3">
        <div className="text-sm font-medium">{t("editor.aiHistory.title")}</div>
        <p className="text-xs text-muted-foreground">{t("editor.aiHistory.hint")}</p>
        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("editor.aiHistory.empty")}</p>
        ) : (
          <ul className="grid max-h-80 gap-1.5 overflow-auto">
            {list.map((p, i) => (
              <PointRow key={p.id} point={p} latest={i === 0} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
