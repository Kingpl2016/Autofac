import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import type { LibraryEntry } from "../lib/types";

interface ProgramDeleteDialogProps {
  /** 待删除的节目；为 `null` 时对话框关闭 */
  entry: LibraryEntry | null;
  onCancel: () => void;
  onConfirm: (entry: LibraryEntry) => void;
}

/** 删除节目的二次确认：写明会移入系统回收站、可以恢复。 */
export function ProgramDeleteDialog({ entry, onCancel, onConfirm }: ProgramDeleteDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={entry !== null}
      onOpenChange={(open) => !open && onCancel()}
      title={t("recording.libDeleteTitle")}
      description={t("recording.libDeleteDesc", { name: entry?.name ?? "" })}
      confirmLabel={t("common.delete")}
      destructive
      onConfirm={() => entry && onConfirm(entry)}
    />
  );
}
