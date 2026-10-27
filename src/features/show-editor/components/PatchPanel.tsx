import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Group, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { footprint } from "@/features/fixtures";
import { announce } from "@/shared/stores/announcerStore";
import { createGroup, removeFixtures, renameFixture, setFixtureAddress } from "../lib/ops";
import { analyzePatch } from "../lib/patch";
import { addMirror, removeMirror, setFixtureMode, setMirror } from "../lib/universeOps";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { EmptyHint } from "./EmptyHint";
import { FixtureRow } from "./FixtureRow";
import { DmxChannelView } from "./DmxChannelView";
import { GroupList } from "./GroupList";
import { RepatchForm } from "./RepatchForm";
import { UniverseMap } from "./UniverseMap";

/**
 * “灯具与 Patch”面板：取代旧的“回路配置”页。
 *
 * 列出节目里的每个灯具及其 DMX 地址，实时检测地址冲突；可勾选多个灯具编成一组，
 * 并用 Universe 占用图一眼看出通道排布。
 */
export function PatchPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedRaw = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelectedFixtures = useEditorUiStore((s) => s.setSelectedFixtures);
  const setFixtureSelected = useEditorUiStore((s) => s.setFixtureSelected);

  const { fixtures, fixtureModels } = project;
  const status = useMemo(() => analyzePatch({ fixtures, fixtureModels }), [fixtures, fixtureModels]);
  const models = useMemo(() => new Map(fixtureModels.map((m) => [m.id, m.name])), [fixtureModels]);
  // 每个模型的可选模式（名称 + 通道数）：默认模式 + 附加模式
  const modeOptions = useMemo(
    () =>
      new Map(
        fixtureModels.map((m) => [
          m.id,
          {
            defaultMode: { name: m.defaultModeName ?? "", channels: footprint(m.properties) },
            modes: (m.modes ?? []).map((x) => ({ id: x.id, name: x.name, channels: footprint(x.properties) })),
          },
        ]),
      ),
    [fixtureModels],
  );
  const [dmxUniverse, setDmxUniverse] = useState<number | null>(null);
  // 选中的灯具可能已被删除（含撤销 / 重做之后），按当前工程过滤
  const selected = useMemo(
    () => selectedRaw.filter((id) => fixtures.some((f) => f.id === id)),
    [selectedRaw, fixtures],
  );
  const conflictCount = useMemo(
    () => [...status.values()].filter((s) => s.conflictsWith.length > 0 || s.overflow).length,
    [status],
  );

  if (fixtures.length === 0) {
    return <EmptyHint>{t("editor.patch.empty")}</EmptyHint>;
  }

  const allSelected = selected.length === fixtures.length;

  const group = () => {
    let id: string | null = null;
    update((d) => {
      id = createGroup(d, t("editor.patch.defaultGroupName", { n: d.groups.length + 1 }), selected);
    });
    if (id) announce(t("editor.patch.grouped", { count: selected.length }));
  };

  const removeSelected = () => {
    const count = selected.length;
    update((d) => removeFixtures(d, selected));
    setSelectedFixtures([]);
    announce(t("editor.patch.removed", { count }));
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      <section aria-label={t("editor.patch.universes")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("editor.patch.universes")}
        </h3>
        <UniverseMap
          project={{ fixtures, fixtureModels, output: project.output }}
          selectedIds={selected}
          onPickUniverse={setDmxUniverse}
        />
        {conflictCount > 0 && (
          <p role="status" className="text-xs font-medium text-destructive">
            {t("editor.patch.conflictSummary", { count: conflictCount })}
          </p>
        )}
      </section>

      <section aria-label={t("editor.patch.fixtures")} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("editor.patch.fixtures")} · {fixtures.length}
          </h3>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={allSelected}
              onChange={(e) => setSelectedFixtures(e.target.checked ? fixtures.map((f) => f.id) : [])}
            />
            {t("editor.patch.selectAll")}
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="h-8" disabled={selected.length < 2} onClick={group}>
            <Group aria-hidden />
            {t("editor.patch.group")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={selected.length === 0}
            onClick={removeSelected}
          >
            <Trash2 aria-hidden />
            {t("editor.patch.deleteSelected", { count: selected.length })}
          </Button>
        </div>
        {selected.length > 0 && (
          <RepatchForm
            key={selected.join(",")}
            fixtureIds={fixtures.filter((f) => selected.includes(f.id)).map((f) => f.id)}
          />
        )}
        <ul className="flex flex-col gap-1.5">
          {fixtures.map((f) => (
            <FixtureRow
              key={f.id}
              fixture={f}
              modelName={models.get(f.modelId) ?? ""}
              modes={modeOptions.get(f.modelId)?.modes}
              defaultMode={modeOptions.get(f.modelId)?.defaultMode}
              status={status.get(f.id)}
              selected={selected.includes(f.id)}
              onSelectedChange={(on) => setFixtureSelected(f.id, on)}
              onRename={(name) => update((d) => renameFixture(d, f.id, name))}
              onAddress={(universe, address) => update((d) => setFixtureAddress(d, f.id, universe, address))}
              onMode={(modeId) => update((d) => setFixtureMode(d, f.id, modeId))}
              onAddMirror={() => update((d) => void addMirror(d, f.id))}
              onMirror={(i, universe, address) => update((d) => setMirror(d, f.id, i, { universe, address }))}
              onRemoveMirror={(i) => update((d) => removeMirror(d, f.id, i))}
              onDelete={() => {
                update((d) => removeFixtures(d, [f.id]));
                setFixtureSelected(f.id, false);
              }}
            />
          ))}
        </ul>
      </section>

      <section aria-label={t("editor.dmx.title")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("editor.dmx.title")}
        </h3>
        <DmxChannelView universe={dmxUniverse} onUniverseChange={setDmxUniverse} />
      </section>

      <section aria-label={t("editor.patch.groups")} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("editor.patch.groups")}
        </h3>
        <GroupList />
      </section>
    </div>
  );
}
