import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** 备注长度上限（字符），避免把超长文本写进 sidecar。 */
const MAX_NOTES = 2000;

interface ProgramNotesEditorProps {
  /** 当前保存的备注 */
  notes: string;
  /** 保存；返回是否成功 */
  onSave: (notes: string) => Promise<boolean>;
}

/**
 * 备注编辑：有改动时才出现“保存 / 还原”，Ctrl+Enter 保存。
 * 以节目路径 + 备注为 key 挂载，换节目或外部改动后自动重置为最新内容。
 */
export function ProgramNotesEditor({ notes, onSave }: ProgramNotesEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(notes);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== notes;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    // 成功后列表刷新，父组件以新备注为 key 重新挂载本组件；失败时保留草稿便于重试
    await onSave(draft);
    setSaving(false);
  };

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t("recording.notes")}
      </label>
      <Textarea
        id={id}
        value={draft}
        maxLength={MAX_NOTES}
        rows={3}
        placeholder={t("library.notesPlaceholder")}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape" && dirty) {
            e.stopPropagation();
            setDraft(notes);
          }
        }}
      />
      <div className="flex min-h-9 items-center justify-between gap-2">
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {dirty ? t("library.notesHint") : ""}
        </span>
        {dirty && (
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" className="h-9 px-3" disabled={saving} onClick={() => setDraft(notes)}>
              {t("library.notesRevert")}
            </Button>
            <Button size="sm" className="h-9 px-3" loading={saving} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
