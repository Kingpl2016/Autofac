import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyCheck, PencilLine, ScanSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { announce } from "@/shared/stores/announcerStore";
import {
  DEFAULT_SYNC_FIELDS,
  renameByPattern,
  sameModelIds,
  SYNC_FIELDS,
  syncFixtures,
  type SyncField,
} from "../lib/fixtureBatch";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";


/**
 * 灯具批量操作条（Patch 面板里勾选灯具时出现）：
 * 以第一台（Patch 列表顺序）为准同步设置（至少两台）、按模板重命名、选中同型号的灯具。
 *
 * @param props.fixtureIds 勾选的灯具（按 Patch 列表顺序）。
 */
export function FixtureBatchBar({ fixtureIds }: { fixtureIds: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const sourceName = useProjectStore((s) => s.project.fixtures.find((f) => f.id === fixtureIds[0])?.name ?? "");
  const setSelectedFixtures = useEditorUiStore((s) => s.setSelectedFixtures);
  const [fields, setFields] = useState<SyncField[]>([...DEFAULT_SYNC_FIELDS]);
  const [pattern, setPattern] = useState("");
  const [start, setStart] = useState("1");
  const id = useId();

  const startNum = Number(start);
  const renameValid = pattern.trim() !== "" && Number.isInteger(startNum) && startNum >= 0;

  const sync = () => {
    let r = { changed: 0, modeSkipped: 0 };
    update((d) => {
      r = syncFixtures(d, fixtureIds[0], fixtureIds, fields);
    });
    announce(
      r.modeSkipped > 0
        ? t("editor.batch.syncedSkipped", { count: r.changed, skipped: r.modeSkipped })
        : t("editor.batch.synced", { count: r.changed }),
    );
  };

  const rename = () => {
    if (!renameValid) return;
    let n = 0;
    update((d) => {
      n = renameByPattern(d, fixtureIds, pattern, startNum);
    });
    announce(t("editor.batch.renamed", { count: n }));
  };

  const selectSame = () => {
    const ids = sameModelIds(useProjectStore.getState().project, fixtureIds);
    setSelectedFixtures(ids);
    announce(t("editor.batch.selectedSame", { count: ids.length }));
  };

  const toggleField = (f: SyncField, on: boolean) =>
    setFields((prev) => (on ? [...prev, f] : prev.filter((x) => x !== f)));

  return (
    <fieldset data-tour="patch-batch" className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2">
      <legend className="px-1 text-xs text-muted-foreground">{t("editor.batch.title", { count: fixtureIds.length })}</legend>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {SYNC_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={fields.includes(f)}
              onChange={(e) => toggleField(f, e.target.checked)}
            />
            {t(`editor.batch.field.${f}`)}
          </label>
        ))}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7"
          disabled={fields.length === 0 || fixtureIds.length < 2}
          onClick={sync}
        >
          <CopyCheck aria-hidden />
          {t("editor.batch.sync", { name: sourceName })}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={`${id}-p`}>
          {t("editor.batch.pattern")}
          <Input
            id={`${id}-p`}
            className="h-7 w-36 px-1.5 text-xs"
            placeholder={t("editor.batch.patternPlaceholder")}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
            }}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={`${id}-s`}>
          {t("editor.batch.start")}
          <Input
            id={`${id}-s`}
            className="num h-7 w-14 px-1.5 text-xs"
            inputMode="numeric"
            value={start}
            aria-invalid={!(Number.isInteger(startNum) && startNum >= 0) || undefined}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <Button type="button" size="sm" variant="secondary" className="h-7" disabled={!renameValid} onClick={rename}>
          <PencilLine aria-hidden />
          {t("editor.batch.rename", { count: fixtureIds.length })}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={selectSame}>
          <ScanSearch aria-hidden />
          {t("editor.batch.selectSame")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("editor.batch.hint")}</p>
    </fieldset>
  );
}
