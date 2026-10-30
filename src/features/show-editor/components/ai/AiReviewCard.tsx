import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronDown, Eye, EyeOff, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { commitStaged, discardStaged } from "../../ai/actions";
import { countChanges, type ChangeEntry } from "../../ai/changes";
import { useAiStagingStore, type StagedChange } from "../../stores/useAiStagingStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";

/** 清单里最多直接列出多少项（其余折叠为“还有 N 项”）。 */
const MAX_ROWS = 60;

/** 改动的计数行：“新增 8 个片段 · 新建 1 个分组”。 */
export function ChangeCounts({ changes, className }: { changes: readonly ChangeEntry[]; className?: string }) {
  const { t } = useTranslation();
  const counts = countChanges(changes);
  if (counts.length === 0) return <span className={className}>{t("editor.ai.noChanges")}</span>;
  return (
    <span className={className}>
      {counts.map(([collection, op, count]) => t(`editor.ai.changes.${collection}.${op}`, { count })).join(" · ")}
    </span>
  );
}

/** 预览开关与应用 / 放弃按钮。 */
export function StagedActions({ staged, compact }: { staged: StagedChange; compact?: boolean }) {
  const { t } = useTranslation();
  const previewing = useAiStagingStore((s) => s.previewing);
  const setPreviewing = useAiStagingStore((s) => s.setPreviewing);
  const size = compact ? "sm" : "default";
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size={size}
        aria-pressed={previewing}
        title={t(previewing ? "editor.ai.previewOnHint" : "editor.ai.previewOffHint")}
        onClick={() => setPreviewing(!previewing)}
      >
        {previewing ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
        {t("editor.ai.preview")}
      </Button>
      <Button variant="outline" size={size} onClick={discardStaged}>
        <X aria-hidden />
        {t("editor.ai.discard")}
      </Button>
      <Button size={size} variant={staged.sensitive ? "destructive" : "default"} onClick={() => commitStaged(t)}>
        <Check aria-hidden />
        {t(staged.sensitive ? "editor.ai.applySensitive" : "editor.ai.apply")}
      </Button>
    </div>
  );
}

/** 一行改动。 */
function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const { t } = useTranslation();
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const tone = entry.op === "added" ? "text-success" : entry.op === "removed" ? "text-destructive" : "text-warning";
  const body = (
    <>
      <span className={cn("w-4 shrink-0 text-center font-mono", tone)} aria-hidden>
        {entry.op === "added" ? "+" : entry.op === "removed" ? "−" : "~"}
      </span>
      <span className="sr-only">{t(`editor.ai.ops.${entry.op}`)}</span>
      <span className="w-14 shrink-0 text-muted-foreground">{t(`editor.ai.kinds.${entry.collection}`)}</span>
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      {entry.detail && <span className="num shrink-0 text-muted-foreground">{entry.detail}</span>}
    </>
  );
  // 片段可以点击把播放头移到它的起点
  if (entry.atMs !== undefined) {
    return (
      <li>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setPlayhead(entry.atMs ?? 0)}
        >
          {body}
        </button>
      </li>
    );
  }
  return <li className="flex items-center gap-2 px-1.5 py-0.5">{body}</li>;
}

/**
 * 待审阅的 AI 改动：模型的说明、计数、逐项清单（片段可点击定位）、警告，以及预览 / 放弃 / 应用。
 * 涉及配接、输出或大批量删除时标出“敏感”，应用按钮变成醒目的确认样式。
 */
export function AiReviewCard({ staged }: { staged: StagedChange }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => (showAll ? staged.changes : staged.changes.slice(0, MAX_ROWS)), [showAll, staged.changes]);
  const warnings = staged.issues.filter((i) => i.level === "warning");

  return (
    <section aria-label={t("editor.ai.reviewTitle")} className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t("editor.ai.reviewTitle")}</h3>
        <Badge variant="secondary">{t(`editor.ai.sources.${staged.source}`)}</Badge>
        {staged.sensitive && (
          <Badge variant="warning">
            <AlertTriangle className="size-3" aria-hidden />
            {t("editor.ai.sensitive")}
          </Badge>
        )}
      </div>
      {staged.summary && <p className="text-sm">{staged.summary}</p>}
      <ChangeCounts changes={staged.changes} className="text-xs text-muted-foreground" />
      {staged.sensitive && <p className="text-xs text-warning">{t("editor.ai.sensitiveHint")}</p>}
      {rows.length > 0 && (
        <ul aria-label={t("editor.ai.changeList")} className="grid max-h-64 gap-0.5 overflow-auto text-xs">
          {rows.map((entry, i) => (
            <ChangeRow key={`${entry.collection}-${entry.id ?? i}-${entry.op}`} entry={entry} />
          ))}
        </ul>
      )}
      {!showAll && staged.changes.length > MAX_ROWS && (
        <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => setShowAll(true)}>
          {t("editor.ai.showAll", { count: staged.changes.length - MAX_ROWS })}
        </Button>
      )}
      {warnings.length > 0 && (
        <details className="text-xs">
          <summary className="flex cursor-pointer items-center gap-1 text-warning">
            <ChevronDown className="size-3" aria-hidden />
            {t("editor.ai.warnings", { count: warnings.length })}
          </summary>
          <ul className="mt-1 grid gap-0.5 pl-4 text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </details>
      )}
      <StagedActions staged={staged} />
    </section>
  );
}
