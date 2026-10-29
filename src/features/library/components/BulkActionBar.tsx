import { useTranslation } from "react-i18next";
import { Trash2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytesIec } from "@/shared/lib/format";
import { formatDurationUs, type LibraryEntry } from "@/features/recording";

interface BulkActionBarProps {
  /** 已勾选的节目 */
  entries: readonly LibraryEntry[];
  canUpload: boolean;
  uploading: boolean;
  onUpload: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * 勾选后出现在表格底部的批量操作条：数量、总时长、总大小；上传 / 取消勾选在左，
 * 删除用危险色单独放在最右，与其它操作隔开。
 */
export function BulkActionBar({ entries, canUpload, uploading, onUpload, onDelete, onClear }: BulkActionBarProps) {
  const { t } = useTranslation();
  const totalUs = entries.reduce((n, e) => n + e.durationUs, 0);
  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  const uploadable = entries.filter((e) => e.valid).length;

  return (
    <div
      role="region"
      aria-label={t("library.bulkLabel")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-primary/5 px-4 py-2"
    >
      <p className="text-sm font-medium" aria-live="polite">
        {t("library.bulkSelected", { n: entries.length })}
        <span className="num ml-2 text-xs font-normal text-muted-foreground">
          {formatDurationUs(totalUs)} · {formatBytesIec(totalBytes)}
        </span>
      </p>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          disabled={!canUpload || uploadable === 0}
          loading={uploading}
          title={canUpload ? undefined : t("recording.libUploadNeedsDevice")}
          onClick={onUpload}
        >
          <Upload />
          {t("library.bulkUpload", { n: uploadable })}
        </Button>
        <Button size="sm" variant="ghost" className="h-9" onClick={onClear}>
          <X />
          {t("library.bulkClear")}
        </Button>
      </div>
      <Button size="sm" variant="destructive" className="h-9" onClick={onDelete}>
        <Trash2 />
        {t("library.bulkDelete", { n: entries.length })}
      </Button>
    </div>
  );
}
