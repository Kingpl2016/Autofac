import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { warningParams } from "../lib/format";
import type { ImportOutcome, ImportWarning } from "../lib/types";

interface ImportResultDialogProps {
  /** 导入结果；为 `null` 时对话框不显示。 */
  outcome: ImportOutcome | null;
  onClose: () => void;
}

/** 警告文案键：OFL 导入的警告没有行号，用不带行号的文案。 */
function warningKey(w: ImportWarning): string {
  if (w.row === null && (w.kind === "unknownFunction" || w.kind === "invalidModel")) return `${w.kind}Ofl`;
  return w.kind;
}

/** 导入结果对话框（Excel / OFL）：新增 / 覆盖 / 忽略统计，以及逐条警告。 */
export function ImportResultDialog({ outcome, onClose }: ImportResultDialogProps) {
  const { t } = useTranslation();
  if (!outcome) return null;
  const { added, updated, skipped, warnings } = outcome;
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

        {warnings.length > 0 && (
          <section aria-label={t("fixtures.import.warnings", { count: warnings.length })}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-warning">
              <TriangleAlert className="size-4" aria-hidden />
              {t("fixtures.import.warnings", { count: warnings.length })}
            </h3>
            <ul className="grid gap-1.5 text-sm">
              {warnings.map((w, i) => (
                <li key={i} className="rounded-md bg-warning/10 px-3 py-1.5">
                  {t(`fixtures.import.warning.${warningKey(w)}`, warningParams(w))}
                </li>
              ))}
            </ul>
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
