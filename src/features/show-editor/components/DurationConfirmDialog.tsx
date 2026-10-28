import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyShowDuration } from "../hooks/editorActions";
import { overflowAt } from "../lib/duration";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 缩短节目时长的确认：列出会被裁短 / 删除的内容，选“裁掉超出部分”或“取消”。
 */
export function DurationConfirmDialog() {
  const { t } = useTranslation();
  const request = useEditorUiStore((s) => s.durationRequest);
  const setRequest = useEditorUiStore((s) => s.setDurationRequest);
  const project = useProjectStore((s) => s.project);
  const overflow = useMemo(() => (request === null ? null : overflowAt(project, request)), [project, request]);

  const lines = overflow
    ? (
        [
          ["trimmedCues", overflow.trimmedCues],
          ["removedCues", overflow.removedCues],
          ["mediaClips", overflow.mediaClips],
          ["sections", overflow.sections],
          ["markers", overflow.markers],
        ] as const
      ).filter(([, n]) => n > 0)
    : [];

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editor.duration.confirmTitle", { time: formatTimecode(request ?? 0) })}</DialogTitle>
          <DialogDescription>{t("editor.duration.confirmDescription")}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-sm">
          {lines.map(([key, n]) => (
            <li key={key}>· {t(`editor.duration.overflow.${key}`, { count: n })}</li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setRequest(null)}>
            {t("editor.duration.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => request !== null && applyShowDuration(request)}>
            {t("editor.duration.trim")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
