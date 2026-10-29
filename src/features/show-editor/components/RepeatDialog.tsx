import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { announce } from "@/shared/stores/announcerStore";
import { repeatCues } from "../lib/timelineEdit";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/** 份数上限。 */
const MAX_COPIES = 64;

/**
 * “复制 N 份”：把选中的片段整组往后复制若干份，每份之间可以留间隔（毫秒或拍）。一次复制是一步撤销。
 */
export function RepeatDialog() {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.repeatOpen);
  const setOpen = useEditorUiStore((s) => s.setRepeatOpen);
  const tempo = useProjectStore((s) => s.project.tempo);
  const [count, setCount] = useState(4);
  const [gap, setGap] = useState(0);
  const [unit, setUnit] = useState<"ms" | "beats">("ms");
  const beatMs = tempo ? 60_000 / tempo.bpm : null;
  const gapMs = unit === "beats" && beatMs ? gap * beatMs : gap;

  const apply = () => {
    const ui = useEditorUiStore.getState();
    const alive = new Set(useProjectStore.getState().project.cues.map((c) => c.id));
    const ids = ui.selectedCueIds.filter((id) => alive.has(id));
    let result = { ids: [] as string[], copies: 0 };
    useProjectStore.getState().update((d) => {
      result = repeatCues(d, ids, count, gapMs);
    });
    setOpen(false);
    if (result.copies > 0) ui.selectCues([...ids, ...result.ids]);
    announce(
      result.copies === count
        ? t("editor.repeat.done", { count: result.copies })
        : t("editor.repeat.partial", { count: result.copies, total: count }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("editor.repeat.title")}</DialogTitle>
          <DialogDescription>{t("editor.repeat.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="flex items-center justify-between gap-2">
            {t("editor.repeat.count")}
            <CommitInput
              className="num h-8 w-20 px-2"
              inputMode="numeric"
              label={t("editor.repeat.count")}
              value={count}
              onCommit={(text) => {
                const n = Math.round(Number(text));
                if (Number.isFinite(n)) setCount(Math.min(MAX_COPIES, Math.max(1, n)));
              }}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span>{t("editor.repeat.gap")}</span>
            <span className="flex items-center gap-1.5">
              <CommitInput
                className="num h-8 w-20 px-2"
                inputMode="numeric"
                label={t("editor.repeat.gap")}
                value={gap}
                onCommit={(text) => {
                  const n = Number(text);
                  if (Number.isFinite(n) && n >= 0) setGap(n);
                }}
              />
              <select
                aria-label={t("editor.repeat.unit")}
                className="h-8 rounded-md border border-input bg-transparent px-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={beatMs ? unit : "ms"}
                onChange={(e) => setUnit(e.target.value === "beats" ? "beats" : "ms")}
              >
                <option value="ms">ms</option>
                {beatMs && <option value="beats">{t("editor.programmer.beats")}</option>}
              </select>
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("editor.duration.cancel")}
          </Button>
          <Button type="button" onClick={apply}>
            {t("editor.repeat.apply", { count })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
