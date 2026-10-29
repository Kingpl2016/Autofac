import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFixtureStore } from "@/features/fixtures";
import { InlineAlert } from "@/shared/components/InlineAlert";
import { applySnapshotUpdates, snapshotUpdates, type SnapshotUpdate } from "../lib/modelUpdates";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 编辑器顶部的“模型有更新”提示：工程里保存的灯具模型与素材库里同编号的模型不一致时出现，
 * 点开后逐个勾选并在一次可撤销的步骤里替换。“暂不更新”只对当前这组差异有效，差异变化后会再次提示。
 */
export function ModelUpdatesBanner() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const library = useFixtureStore((s) => s.models);
  const status = useFixtureStore((s) => s.status);
  const load = useFixtureStore((s) => s.load);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const updates = useMemo(
    () => (status === "ready" ? snapshotUpdates(project, library) : []),
    [project, library, status],
  );
  const signature = updates.map((u) => u.modelId).join("|");
  if (updates.length === 0 || dismissed === signature) return null;

  const review = () => {
    setPicked(new Set(updates.map((u) => u.modelId)));
    setOpen(true);
  };

  const apply = () => {
    const models = library.filter((m) => picked.has(m.id));
    let reset: string[] = [];
    useProjectStore.getState().update((d) => {
      reset = applySnapshotUpdates(d, models);
    });
    setOpen(false);
    toast.success(
      reset.length > 0
        ? t("editor.modelUpdates.appliedReset", { count: models.length, reset: reset.length })
        : t("editor.modelUpdates.applied", { count: models.length }),
    );
  };

  return (
    <>
      <InlineAlert tone="info" className="mx-2 mt-2 shrink-0" onDismiss={() => setDismissed(signature)}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {t("editor.modelUpdates.banner", { count: updates.length })}
          <Button type="button" size="sm" variant="outline" className="h-7" onClick={review}>
            <RefreshCw aria-hidden />
            {t("editor.modelUpdates.review")}
          </Button>
        </span>
      </InlineAlert>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("editor.modelUpdates.title")}</DialogTitle>
            <DialogDescription>{t("editor.modelUpdates.description")}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2" aria-label={t("editor.modelUpdates.title")}>
            {updates.map((u) => (
              <UpdateRow
                key={u.modelId}
                update={u}
                checked={picked.has(u.modelId)}
                onChange={(on) =>
                  setPicked((cur) => {
                    const next = new Set(cur);
                    if (on) next.add(u.modelId);
                    else next.delete(u.modelId);
                    return next;
                  })
                }
              />
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("editor.modelUpdates.dismiss")}
            </Button>
            <Button type="button" onClick={apply} disabled={picked.size === 0}>
              {t("editor.modelUpdates.apply", { count: picked.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 一个模型的更新摘要与勾选框。 */
function UpdateRow({ update, checked, onChange }: { update: SnapshotUpdate; checked: boolean; onChange: (on: boolean) => void }) {
  const { t } = useTranslation();
  const id = `model-update-${update.modelId}`;
  const details = [
    t("editor.modelUpdates.fixtures", { count: update.fixtures }),
    update.channels[0] !== update.channels[1]
      ? t("editor.modelUpdates.channels", { from: update.channels[0], to: update.channels[1] })
      : null,
    update.changedChannels > 0 ? t("editor.modelUpdates.changed", { count: update.changedChannels }) : null,
    update.modesAdded.length > 0 ? t("editor.modelUpdates.modesAdded", { names: update.modesAdded.join("、") }) : null,
    update.modesRemoved.length > 0 ? t("editor.modelUpdates.modesRemoved", { names: update.modesRemoved.join("、") }) : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
        <span className="block font-medium">{update.name}</span>
        <span className="num block text-xs text-muted-foreground">{update.modelId}</span>
        <span className="block text-xs text-muted-foreground">{details.join(" · ")}</span>
      </label>
    </li>
  );
}
