import { useTranslation } from "react-i18next";
import { ClipboardCopy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fixtureErrorText } from "../lib/errors";
import { warningParams } from "../lib/format";
import type { ImportOutcome, ImportWarning } from "../lib/types";

interface ImportResultDialogProps {
  /** 导入结果；为 `null` 时对话框不显示。 */
  outcome: ImportOutcome | null;
  onClose: () => void;
}

/** 每个模型最多直接列出的提示条数（整库导入时一个模型可能有几十条）。 */
const MAX_PER_GROUP = 20;

/** 警告文案键：OFL 导入的警告没有行号，用不带行号的文案。 */
function warningKey(w: ImportWarning): string {
  if (w.row === null && (w.kind === "unknownFunction" || w.kind === "invalidModel")) return `${w.kind}Ofl`;
  return w.kind;
}

/**
 * 按模型分组（保持首次出现的顺序）。
 *
 * @param warnings 全部警告。
 * @returns `[模型编号, 警告]` 列表；没有模型编号的归入空串组。
 */
function groupByModel(warnings: readonly ImportWarning[]): [string, ImportWarning[]][] {
  const groups = new Map<string, ImportWarning[]>();
  for (const w of warnings) {
    const key = w.modelId ?? "";
    const list = groups.get(key);
    if (list) list.push(w);
    else groups.set(key, [w]);
  }
  return [...groups];
}

/** 导入结果对话框（Excel / OFL）：新增 / 覆盖 / 忽略统计，以及按模型分组的提示。 */
export function ImportResultDialog({ outcome, onClose }: ImportResultDialogProps) {
  const { t } = useTranslation();
  if (!outcome) return null;
  const { added, updated, skipped, warnings } = outcome;
  const failed = outcome.failed ?? [];
  const text = (w: ImportWarning) => t(`fixtures.import.warning.${warningKey(w)}`, warningParams(w));
  const groups = groupByModel(warnings);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(warnings.map(text).join("\n"));
      toast.success(t("fixtures.import.copied"));
    } catch {
      toast.error(t("common.unknownError"));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("fixtures.import.title")}</DialogTitle>
          <DialogDescription>
            {t("fixtures.import.summary", {
              added: added.length,
              updated: updated.length,
              skipped: skipped.length,
            })}
          </DialogDescription>
        </DialogHeader>

        {skipped.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("fixtures.import.skipped", { ids: skipped.join("、") })}
          </p>
        )}

        {failed.length > 0 && (
          <section aria-label={t("fixtures.import.failedTitle", { count: failed.length })}>
            <h3 className="mb-2 text-sm font-medium text-destructive">{t("fixtures.import.failedTitle", { count: failed.length })}</h3>
            <ul className="grid gap-1 text-sm">
              {failed.slice(0, MAX_PER_GROUP).map((f) => (
                <li key={f.key} className="rounded-md bg-destructive/10 px-3 py-1.5">
                  <span className="num">{f.key}</span>：{fixtureErrorText(t, f.code)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {warnings.length > 0 && (
          <section aria-label={t("fixtures.import.warnings", { count: warnings.length })}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium text-warning">
                <TriangleAlert className="size-4" aria-hidden />
                {t("fixtures.import.warnings", { count: warnings.length })}
              </h3>
              <Button type="button" variant="ghost" size="sm" onClick={() => void copyAll()}>
                <ClipboardCopy aria-hidden />
                {t("fixtures.import.copyWarnings")}
              </Button>
            </div>
            <div className="grid gap-2">
              {groups.map(([model, list]) => (
                <details key={model} open={groups.length === 1} className="rounded-md border border-border">
                  <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                    {t("fixtures.import.warningGroup", { model: model || "—", count: list.length })}
                  </summary>
                  <ul className="grid gap-1.5 px-3 pb-2 text-sm">
                    {list.slice(0, MAX_PER_GROUP).map((w, i) => (
                      <li key={i} className="rounded-md bg-warning/10 px-3 py-1.5">
                        {text(w)}
                      </li>
                    ))}
                  </ul>
                  {list.length > MAX_PER_GROUP && (
                    <p className="px-3 pb-2 text-xs text-muted-foreground">
                      {t("fixtures.import.warningMore", { count: list.length - MAX_PER_GROUP })}
                    </p>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
