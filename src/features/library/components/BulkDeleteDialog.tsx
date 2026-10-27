import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LibraryEntry, ProgramActions } from "@/features/recording";

interface BulkDeleteDialogProps {
  /** 要删除的节目；为空数组时对话框关闭 */
  entries: readonly LibraryEntry[];
  actions: ProgramActions;
  onClose: () => void;
  /** 删除结束（含部分失败）后调用，参数是成功删除的路径 */
  onDone: (deleted: string[]) => void;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running"; done: number }
  | { kind: "done"; deleted: string[]; failed: { name: string; reason: string }[] };

/** 外层：每次打开都是全新实例（不用 effect 重置阶段状态）。 */
export function BulkDeleteDialog(props: BulkDeleteDialogProps) {
  if (props.entries.length === 0) return null;
  return <BulkDeleteDialogBody {...props} />;
}

/**
 * 批量删除：确认（写明移入回收站、可恢复）→ 逐个删除并显示进度（期间不可关闭）→
 * 全部成功直接关闭，有失败时列出失败的节目与原因。
 */
function BulkDeleteDialogBody({ entries, actions, onClose, onDone }: BulkDeleteDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const running = phase.kind === "running";

  const run = async () => {
    const deleted: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    setPhase({ kind: "running", done: 0 });
    for (const [i, e] of entries.entries()) {
      const reason = await actions.removeQuiet(e);
      if (reason === null) deleted.push(e.path);
      else failed.push({ name: e.name, reason });
      setPhase({ kind: "running", done: i + 1 });
    }
    onDone(deleted);
    if (failed.length === 0) onClose();
    else setPhase({ kind: "done", deleted, failed });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onPointerDownOutside={(e) => running && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === "done" ? t("library.bulkDeleteResult") : t("library.bulkDeleteTitle", { n: entries.length })}
          </DialogTitle>
          <DialogDescription>
            {phase.kind === "done"
              ? t("library.bulkDeletePartial", { ok: phase.deleted.length, failed: phase.failed.length })
              : t("library.bulkDeleteDesc")}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "confirm" && (
          <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-sm">
            {entries.map((e) => (
              <li key={e.path} className="truncate">
                {e.name}
              </li>
            ))}
          </ul>
        )}
        {running && (
          <div className="grid gap-2" role="status">
            <p className="text-sm">{t("library.bulkDeleting", { done: phase.done, n: entries.length })}</p>
            <progress className="h-2 w-full accent-primary" max={entries.length} value={phase.done} />
          </div>
        )}
        {phase.kind === "done" && (
          <ul className="max-h-48 overflow-y-auto text-sm" role="list">
            {phase.failed.map((f) => (
              <li key={f.name} className="py-1">
                <span className="font-medium">{f.name}</span>
                <span className="block text-xs break-words text-destructive">{f.reason}</span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {phase.kind === "done" ? (
            <Button onClick={onClose}>{t("common.close")}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" loading={running} onClick={() => void run()}>
                {t("common.delete")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
