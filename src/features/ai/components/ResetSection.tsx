import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArchiveRestore, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/shared/lib/errors";
import { clearUserMemory, resetAiPrefs, restoreTrashEntry } from "../lib/resetActions";
import { trashList, trashRemove, type TrashEntry } from "../lib/skillsApi";
import { useAiMemoryStore } from "../stores/useAiMemoryStore";

/** 与设置页的设置行一致的行样式。 */
const ROW = "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** 回收站保留天数。 */
const KEEP_DAYS = 30;

/** 恢复默认前的确认。 */
function ConfirmReset({ title, body, onConfirm, onClose }: { title: string; body: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {t("ai.reset.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 设置页里的“恢复默认与回收站”：AI 偏好恢复默认、清空个人偏好记忆（都先备份进回收站，可撤销），
 * 以及回收站列表（删除的技能、MCP 服务器、记忆与备份，30 天内可恢复）。
 */
export function ResetSection() {
  const { t, i18n } = useTranslation();
  const memoryCount = useAiMemoryStore((s) => s.prefs.length);
  const [confirm, setConfirm] = useState<"prefs" | "memory" | null>(null);
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  // 读列表时的时间（算剩余天数用）
  const [now, setNow] = useState(0);
  const refresh = useCallback(() => {
    void trashList()
      .then((list) => {
        setEntries(list);
        setNow(Date.now());
      })
      .catch(() => setEntries([]));
  }, []);
  useEffect(refresh, [refresh]);

  const restore = async (e: TrashEntry) => {
    try {
      await restoreTrashEntry(e);
      toast.success(t("ai.reset.restored", { name: e.label }));
    } catch (err) {
      toast.error(t("ai.reset.restoreFailed", { reason: errorMessage(err) }));
    }
    refresh();
  };
  const purge = async (e: TrashEntry) => {
    await trashRemove(e.id).catch(() => undefined);
    refresh();
  };
  const daysLeft = (e: TrashEntry) => Math.max(0, KEEP_DAYS - Math.floor((now - e.deletedAtMs) / 86_400_000));

  return (
    <>
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.reset.prefsTitle")}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.reset.prefsHint")}</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfirm("prefs")}>
          <RotateCcw />
          {t("ai.reset.restoreDefaults")}
        </Button>
      </div>
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.reset.memoryTitle")}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.reset.memoryHint")}</div>
        </div>
        <Button variant="outline" size="sm" disabled={memoryCount === 0} onClick={() => setConfirm("memory")}>
          <Trash2 />
          {t("ai.reset.clearMemory", { count: memoryCount })}
        </Button>
      </div>
      <div data-slot="setting-row" className="grid gap-2 px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.reset.trashTitle")}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.reset.trashHint")}</div>
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("ai.reset.trashEmpty")}</p>
        ) : (
          <ul className="grid gap-1">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                <Badge variant="secondary">{t(`ai.reset.kinds.${e.kind}`, { defaultValue: e.kind })}</Badge>
                <span className="min-w-0 flex-1 truncate" title={e.label}>
                  {e.label}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {new Date(e.deletedAtMs).toLocaleDateString(i18n.language)} · {t("ai.reset.daysLeft", { count: daysLeft(e) })}
                </span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void restore(e)}>
                  <ArchiveRestore aria-hidden />
                  {t("ai.reset.restore")}
                </Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t("ai.reset.purge", { name: e.label })} title={t("ai.reset.purge", { name: e.label })} onClick={() => void purge(e)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirm === "prefs" && (
        <ConfirmReset
          title={t("ai.reset.prefsTitle")}
          body={t("ai.reset.prefsConfirm")}
          onConfirm={async () => {
            await resetAiPrefs(t);
            refresh();
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "memory" && (
        <ConfirmReset
          title={t("ai.reset.memoryTitle")}
          body={t("ai.reset.memoryConfirm", { count: memoryCount })}
          onConfirm={async () => {
            await clearUserMemory(t);
            refresh();
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
