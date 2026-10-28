import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyCheck, PencilLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { announce } from "@/shared/stores/announcerStore";
import { DEFAULT_SYNC_FIELDS, renameByPattern, SYNC_FIELDS, syncFixtures, type SyncField } from "../lib/fixtureBatch";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 按模板批量重命名所选灯具（`{n}` 为序号，`{name}` 为原名），一步撤销。放在详情区的“基本”分区里。
 *
 * @param props.fixtureIds 所选灯具（按 Patch 列表顺序）。
 */
export function BatchRename({ fixtureIds }: { fixtureIds: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const [pattern, setPattern] = useState("");
  const [start, setStart] = useState("1");
  const id = useId();
  const startNum = Number(start);
  const valid = pattern.trim() !== "" && Number.isInteger(startNum) && startNum >= 0;

  const rename = () => {
    if (!valid) return;
    let n = 0;
    update((d) => {
      n = renameByPattern(d, fixtureIds, pattern, startNum);
    });
    announce(t("editor.batch.renamed", { count: n }));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground" htmlFor={`${id}-p`}>
        <span className="shrink-0">{t("editor.batch.pattern")}</span>
        <Input
          id={`${id}-p`}
          className="h-7 min-w-24 flex-1 px-1.5 text-xs"
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
          className="num h-7 w-12 px-1.5 text-xs"
          inputMode="numeric"
          value={start}
          aria-invalid={!(Number.isInteger(startNum) && startNum >= 0) || undefined}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <Button type="button" size="sm" variant="secondary" className="h-7" disabled={!valid} onClick={rename}>
        <PencilLine aria-hidden />
        {t("editor.batch.rename", { count: fixtureIds.length })}
      </Button>
    </div>
  );
}

/**
 * 以第一台（Patch 列表顺序）为准，把勾选的字段同步到其余灯具（至少两台），一步撤销。
 *
 * @param props.fixtureIds 所选灯具（按 Patch 列表顺序）。
 */
export function BatchSync({ fixtureIds }: { fixtureIds: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const sourceName = useProjectStore((s) => s.project.fixtures.find((f) => f.id === fixtureIds[0])?.name ?? "");
  const [fields, setFields] = useState<SyncField[]>([...DEFAULT_SYNC_FIELDS]);

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

  return (
    <div role="group" aria-label={t("editor.batch.title", { count: fixtureIds.length })} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {SYNC_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={fields.includes(f)}
              onChange={(e) => setFields((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))}
            />
            {t(`editor.batch.field.${f}`)}
          </label>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 self-start"
        disabled={fields.length === 0 || fixtureIds.length < 2}
        onClick={sync}
      >
        <CopyCheck aria-hidden />
        {t("editor.batch.sync", { name: sourceName })}
      </Button>
      <p className="text-[11px] text-muted-foreground">{t("editor.batch.hint")}</p>
    </div>
  );
}
