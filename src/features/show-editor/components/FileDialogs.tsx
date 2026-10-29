import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RECORDINGS_QUERY_KEY, recordingsList } from "@/features/recording";
import type { ShowFileController } from "../hooks/useShowFile";
import { useDocumentStore } from "../stores/useDocumentStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ImportShowDialog, ShowInfoDialog } from "./FileExtraDialogs";

/** 工程文件相关的全部对话框：保存到节目库、从节目库打开、未保存提示、恢复提示。 */
export function FileDialogs({ file }: { file: ShowFileController }) {
  return (
    <>
      <SaveToLibraryDialog file={file} />
      <OpenFromLibraryDialog file={file} />
      <UnsavedDialog file={file} />
      <RecoverDialog file={file} />
      <ReloadDialog file={file} />
      {file.dialog === "import" && <ImportShowDialog onClose={file.closeDialog} />}
      {file.dialog === "info" && <ShowInfoDialog file={file} />}
    </>
  );
}

/** 重新载入前的确认：未保存的修改会丢失。 */
function ReloadDialog({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  if (file.dialog !== "reload") return null;
  return (
    <Dialog open onOpenChange={(o) => !o && file.closeDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editor.file.reloadTitle")}</DialogTitle>
          <DialogDescription>{t("editor.file.reloadDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={file.closeDialog}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={file.confirmReload}>
            {t("editor.file.reloadConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 保存到节目库对话框：名称和备注。每次打开都是全新实例，表单用初值初始化。
 */
function SaveToLibraryDialog({ file }: { file: ShowFileController }) {
  if (file.dialog !== "save") return null;
  return <SaveForm file={file} />;
}

function SaveForm({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  const project = useProjectStore.getState().project;
  const inLibrary = useDocumentStore.getState().origin.kind === "library" && !file.saveAsNew;
  const [name, setName] = useState(project.name || t("editor.untitled"));
  const [notes, setNotes] = useState(project.notes);
  const [saving, setSaving] = useState(false);
  const valid = name.trim() !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await file.submitSave({ name, notes });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !saving && !o && file.closeDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{file.saveAsNew ? t("editor.file.saveAsNewTitle") : t("editor.file.saveTitle")}</DialogTitle>
          <DialogDescription>
            {inLibrary ? t("editor.file.saveOverwriteHint") : t("editor.file.saveDescription")}
          </DialogDescription>
        </DialogHeader>
        <form id="save-show-form" className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="show-name">{t("editor.file.name")}</Label>
            <Input id="show-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
            {!valid && <p role="alert" className="text-xs text-destructive">{t("editor.file.nameRequired")}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="show-notes">{t("editor.file.notes")}</Label>
            <Textarea id="show-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={file.closeDialog} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="save-show-form" disabled={saving || !valid}>
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 从节目库选择一个可编辑的节目打开。 */
function OpenFromLibraryDialog({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  const open = file.dialog === "open";
  const list = useQuery({ queryKey: RECORDINGS_QUERY_KEY, queryFn: recordingsList, enabled: open });
  if (!open) return null;
  const editable = (list.data ?? []).filter((e) => e.editable);
  return (
    <Dialog open onOpenChange={(o) => !o && file.closeDialog()}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("editor.file.openTitle")}</DialogTitle>
          <DialogDescription>{t("editor.file.openDescription")}</DialogDescription>
        </DialogHeader>
        {list.isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
        {list.isError && <p role="alert" className="text-sm text-destructive">{t("editor.file.openFailed")}</p>}
        {!list.isLoading && !list.isError && editable.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("editor.file.openEmpty")}</p>
        )}
        <ul className="grid gap-1.5">
          {editable.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => file.chooseLibraryEntry(e.path)}
                className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Clapperboard className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{e.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {new Date(e.modifiedUnixMs).toLocaleString()}
                  </span>
                </span>
                {!e.exported && <Badge variant="warning">{t("recording.libNotExported")}</Badge>}
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={file.closeDialog}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 有未保存的修改时，新建 / 打开前的确认：保存、不保存、取消。 */
function UnsavedDialog({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  if (file.dialog !== "unsaved") return null;
  return (
    <Dialog open onOpenChange={(o) => !o && file.answerUnsaved("cancel")}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editor.file.unsavedTitle")}</DialogTitle>
          <DialogDescription>{t("editor.file.unsavedDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => file.answerUnsaved("cancel")}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => file.answerUnsaved("discard")}>
            {t("editor.file.discard")}
          </Button>
          <Button type="button" onClick={() => file.answerUnsaved("save")}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 上次异常退出时留下了自动存档：恢复或放弃。 */
function RecoverDialog({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  if (file.dialog !== "recover") return null;
  return (
    <Dialog open onOpenChange={(o) => !o && file.answerRecover(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editor.file.recoverTitle")}</DialogTitle>
          <DialogDescription>{t("editor.file.recoverDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => file.answerRecover(false)}>
            {t("editor.file.recoverDiscard")}
          </Button>
          <Button type="button" onClick={() => file.answerRecover(true)}>
            {t("editor.file.recoverRestore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
