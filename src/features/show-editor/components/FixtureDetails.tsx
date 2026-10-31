import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, Crosshair, Group, RotateCcw, ScanSearch, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { footprint, type FixtureModel } from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { toggleLocate } from "../hooks/transportActions";
import { sameModelIds } from "../lib/fixtureBatch";
import { groupSelection } from "../lib/fixtureSelection";
import { createGroup, removeFixtures, renameFixture, setFixtureAddress } from "../lib/ops";
import type { PatchStatus } from "../lib/patch";
import type { FixtureInstance } from "../lib/project";
import { resetPlacements, setFixturePlacement, setFixturePosition } from "../lib/stageOps";
import { addMirror, removeMirror, setFixtureMode, setMirror } from "../lib/universeOps";
import { placeFixtures } from "../stage/stageGeometry";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { BatchRename, BatchSync } from "./FixtureBatchBar";
import { InspectorSection } from "./InspectorSection";
import { RepatchForm } from "./RepatchForm";

/** 默认模式在下拉框里的取值（Radix Select 不接受空串）。 */
const DEFAULT_MODE = "__default__";

/** 多台灯具的值不同。 */
const MIXED = Symbol("mixed");

/**
 * 一组值的共同值。
 *
 * @param values 值。
 * @returns 都相同时为该值，否则为 [`MIXED`]。
 */
function common<T>(values: readonly T[]): T | typeof MIXED {
  return values.every((v) => v === values[0]) ? values[0] : MIXED;
}

/**
 * 数字的显示：保留至多 2 位小数。
 *
 * @param v 数值。
 * @returns 文本。
 */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** 一组 “U … @ …” 地址输入。 */
function AddressInputs({
  universe,
  address,
  universeLabel,
  addressLabel,
  onChange,
}: {
  universe: number;
  address: number;
  universeLabel: string;
  addressLabel: string;
  onChange: (universe: number, address: number) => void;
}) {
  return (
    <>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        U
        <CommitInput
          className="num h-7 w-14 px-1.5 text-xs"
          inputMode="numeric"
          label={universeLabel}
          value={universe}
          onCommit={(text) => onChange(Number(text), address)}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        @
        <CommitInput
          className="num h-7 w-14 px-1.5 text-xs"
          inputMode="numeric"
          label={addressLabel}
          value={address}
          onCommit={(text) => onChange(universe, Number(text))}
        />
      </label>
    </>
  );
}

/** 带单位的数字字段（多选时值不同显示“混合”）。 */
function NumberField({
  label,
  value,
  unit,
  mixedLabel,
  onCommit,
}: {
  label: string;
  value: number | typeof MIXED;
  unit: string;
  mixedLabel: string;
  onCommit: (v: number) => void;
}) {
  // 两列网格里的一格：标签按内容宽度，输入框占满剩下的空间
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <CommitInput
        className="num h-7 min-w-0 flex-1 px-1.5 text-xs"
        inputMode="numeric"
        label={label}
        value={value === MIXED ? "" : num(value)}
        placeholder={value === MIXED ? mixedLabel : undefined}
        onCommit={(text) => {
          const v = Number(text);
          if (text.trim() !== "" && Number.isFinite(v)) onCommit(v);
        }}
      />
      <span>{unit}</span>
    </label>
  );
}

/** 一行“标签：内容”。 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-1.5 text-xs">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

interface FixtureDetailsProps {
  /** 所选灯具（按 Patch 列表顺序，至少一台） */
  ids: readonly string[];
  status: ReadonlyMap<string, PatchStatus>;
}

/**
 * 所选灯具的详情（Figma / 剪映属性面板式）：顶部“已选 N 台”的摘要与操作，下面按分区排列属性。
 *
 * 单台可改名称、模式、地址、镜像、舞台坐标；多台时名称按模板批量改、地址用顺序配接，
 * 共同属性（模式、高度、朝向、吊挂）直接改全部，值不同时显示“混合”。每次修改一步撤销。
 */
export function FixtureDetails({ ids, status }: FixtureDetailsProps) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const selectGroup = useEditorUiStore((s) => s.selectGroup);
  const selectedGroupId = useEditorUiStore((s) => s.selectedGroupId);
  const locateId = usePlaybackStore((s) => s.state?.locate ?? null);

  const fixtures = useMemo(() => {
    const set = new Set(ids);
    return project.fixtures.filter((f) => set.has(f.id));
  }, [project.fixtures, ids]);
  const modelById = useMemo(() => new Map(project.fixtureModels.map((m) => [m.id, m])), [project.fixtureModels]);
  const positions = useMemo(() => placeFixtures(project.fixtures, project.stage), [project.fixtures, project.stage]);
  const single: FixtureInstance | undefined = fixtures.length === 1 ? fixtures[0] : undefined;
  const fixtureIds = fixtures.map((f) => f.id);
  const mixed = t("editor.cue.mixed");

  if (fixtures.length === 0) return null;

  // 型号汇总：PAR ×3 · 摇头灯 ×1
  const byModel = new Map<string, number>();
  for (const f of fixtures) byModel.set(f.modelId, (byModel.get(f.modelId) ?? 0) + 1);
  const modelSummary = [...byModel].map(([id, n]) => t("editor.patch.modelCount", { name: modelById.get(id)?.name ?? id, count: n })).join(" · ");
  const sameModel: FixtureModel | undefined = byModel.size === 1 ? modelById.get(fixtures[0].modelId) : undefined;
  const modeChoices = sameModel
    ? [
        { id: DEFAULT_MODE, name: sameModel.defaultModeName || t("editor.patch.defaultMode"), channels: footprint(sameModel.properties) },
        ...(sameModel.modes ?? []).map((m) => ({ id: m.id, name: m.name, channels: footprint(m.properties) })),
      ]
    : [];
  const mode = common(fixtures.map((f) => f.modeId ?? DEFAULT_MODE));
  const problems = fixtures.filter((f) => {
    const s = status.get(f.id);
    return s && (s.conflictsWith.length > 0 || s.overflow || s.missingModel);
  }).length;
  const groups = project.groups.filter((g) => g.fixtureIds.some((id) => ids.includes(id)));

  const placementOf = (f: FixtureInstance) => f.stage ?? positions.get(f.id) ?? { x: 0, y: 0 };
  const z = common(fixtures.map((f) => f.stage?.z ?? 0));
  const rotation = common(fixtures.map((f) => f.stage?.rotation ?? 0));
  const pitch = common(fixtures.map((f) => f.stage?.pitch ?? 0));
  const hanging = common(fixtures.map((f) => f.stage?.hanging === true));

  const group = () => {
    let id: string | null = null;
    update((d) => {
      id = createGroup(d, t("editor.patch.defaultGroupName", { n: d.groups.length + 1 }), fixtureIds);
    });
    if (id) announce(t("editor.patch.grouped", { count: fixtureIds.length }));
  };
  const remove = () => {
    const count = fixtureIds.length;
    update((d) => removeFixtures(d, fixtureIds));
    setSelected([]);
    announce(t("editor.patch.removed", { count }));
  };
  const selectSame = () => {
    const same = sameModelIds(useProjectStore.getState().project, fixtureIds);
    setSelected(same);
    announce(t("editor.batch.selectedSame", { count: same.length }));
  };

  const iconButton = (label: string, icon: ReactNode, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean } = {}) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7", opts.pressed && "bg-primary/20 text-primary")}
      aria-label={label}
      aria-pressed={opts.pressed}
      title={label}
      disabled={opts.disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  );

  const singleStatus = single ? status.get(single.id) : undefined;

  return (
    <div className="flex flex-col">
      {/* 摘要与操作：始终在详情区顶部 */}
      <div data-tour="patch-batch" className="sticky top-0 z-10 flex flex-col gap-1 border-b border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{single ? single.name : t("editor.patch.selectedCount", { count: fixtures.length })}</p>
            <p className="truncate text-[11px] text-muted-foreground" title={modelSummary}>
              {modelSummary}
            </p>
          </div>
          {iconButton(t("editor.patch.clearSelection"), <X aria-hidden />, () => setSelected([]))}
        </div>
        <div role="toolbar" aria-label={t("editor.patch.actions")} className="flex flex-wrap items-center gap-1">
          {single &&
            iconButton(t("editor.patch.locate", { name: single.name }), <Crosshair aria-hidden />, () => void toggleLocate(single.id), {
              pressed: locateId === single.id,
            })}
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={fixtures.length < 2} onClick={group}>
            <Group aria-hidden />
            {t("editor.patch.group")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={selectSame}>
            <ScanSearch aria-hidden />
            {t("editor.batch.selectSame")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={remove}>
            <Trash2 aria-hidden />
            {single ? t("editor.patch.deleteOne", { name: single.name }) : t("editor.patch.deleteSelected", { count: fixtures.length })}
          </Button>
        </div>
      </div>

      <InspectorSection scope="patch" id="basic" title={t("editor.patch.sections.basic")}>
        {single ? (
          <Row label={t("editor.patch.name")}>
            <CommitInput
              className="h-7 px-2 text-xs"
              label={t("editor.patch.nameOf", { name: single.name })}
              value={single.name}
              onCommit={(name) => update((d) => renameFixture(d, single.id, name))}
            />
          </Row>
        ) : (
          <BatchRename fixtureIds={fixtureIds} />
        )}
        <Row label={t("editor.patch.model")}>
          <span className="truncate" title={modelSummary}>
            {single ? (modelById.get(single.modelId)?.name ?? single.modelId) : modelSummary}
          </span>
        </Row>
        {modeChoices.length > 1 && (
          <Row label={t("editor.patch.mode")}>
            <Select
              value={mode === MIXED ? "" : mode}
              onValueChange={(v) => update((d) => fixtureIds.forEach((id) => setFixtureMode(d, id, v === DEFAULT_MODE ? undefined : v)))}
            >
              <SelectTrigger
                className="h-7 w-auto min-w-28 gap-1 px-2 text-xs"
                aria-label={single ? t("editor.patch.modeOf", { name: single.name }) : t("editor.patch.modesOf")}
              >
                <SelectValue placeholder={mixed} />
              </SelectTrigger>
              <SelectContent>
                {modeChoices.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {t("editor.patch.modeOption", { name: m.name, count: m.channels })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}
        {!sameModel && fixtures.length > 1 && <p className="text-[11px] text-muted-foreground">{t("editor.patch.modeMixedModels")}</p>}
      </InspectorSection>

      <InspectorSection
        scope="patch"
        id="dmx"
        title={t("editor.patch.sections.dmx")}
        aside={
          problems > 0 ? (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangle aria-hidden className="size-3.5" />
              {problems}
            </span>
          ) : null
        }
      >
        {single ? (
          <>
            <Row label={t("editor.patch.address")}>
              <AddressInputs
                universe={single.universe}
                address={single.address}
                universeLabel={t("editor.patch.universeOf", { name: single.name })}
                addressLabel={t("editor.patch.addressOf", { name: single.name })}
                onChange={(u, a) => update((d) => setFixtureAddress(d, single.id, u, a))}
              />
              {singleStatus?.range && (
                <span className="num text-muted-foreground">
                  {singleStatus.range.start}–{singleStatus.range.end}
                </span>
              )}
            </Row>
            {singleStatus && (singleStatus.conflictsWith.length > 0 || singleStatus.overflow || singleStatus.missingModel) && (
              <div className="flex flex-wrap gap-1">
                {singleStatus.conflictsWith.length > 0 && (
                  <Badge variant="destructive">
                    <AlertTriangle className="size-3" aria-hidden />
                    {t("editor.patch.conflict", { count: singleStatus.conflictsWith.length })}
                  </Badge>
                )}
                {singleStatus.overflow && <Badge variant="destructive">{t("editor.patch.overflow")}</Badge>}
                {singleStatus.missingModel && <Badge variant="destructive">{t("editor.patch.missingModel")}</Badge>}
              </div>
            )}
            {(single.mirrors?.length ?? 0) > 0 && (
              <ol aria-label={t("editor.patch.mirrors", { name: single.name })} className="flex flex-col gap-1">
                {single.mirrors?.map((m, i) => {
                  const r = singleStatus?.mirrors[i];
                  return (
                    <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="w-14 shrink-0">{t("editor.patch.mirrorN", { n: i + 1 })}</span>
                      <AddressInputs
                        universe={m.universe}
                        address={m.address}
                        universeLabel={t("editor.patch.mirrorUniverseOf", { name: single.name, n: i + 1 })}
                        addressLabel={t("editor.patch.mirrorAddressOf", { name: single.name, n: i + 1 })}
                        onChange={(u, a) => update((d) => setMirror(d, single.id, i, { universe: u, address: a }))}
                      />
                      {r && (
                        <span className="num">
                          {r.start}–{r.end}
                        </span>
                      )}
                      {iconButton(t("editor.patch.removeMirror", { name: single.name, n: i + 1 }), <X aria-hidden />, () =>
                        update((d) => removeMirror(d, single.id, i)),
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-xs"
              aria-label={t("editor.patch.addMirror", { name: single.name })}
              title={t("editor.patch.addMirror", { name: single.name })}
              onClick={() => update((d) => void addMirror(d, single.id))}
            >
              <Copy aria-hidden />
              {t("editor.patch.addMirrorShort")}
            </Button>
          </>
        ) : (
          <RepatchForm key={fixtureIds.join(",")} fixtureIds={fixtureIds} />
        )}
      </InspectorSection>

      <InspectorSection scope="patch" id="placement" title={t("editor.patch.sections.placement")}>
        {/* 两个字段一行：X / Y（仅单台）、高度 / 朝向、吊挂 / 复位 */}
        {single && (
          <div data-testid="placement-row" className="grid grid-cols-2 gap-2">
            <NumberField
              label={t("editor.patch.posX")}
              value={placementOf(single).x}
              unit="m"
              mixedLabel={mixed}
              onCommit={(x) => update((d) => setFixturePosition(d, single.id, { x }))}
            />
            <NumberField
              label={t("editor.patch.posY")}
              value={placementOf(single).y}
              unit="m"
              mixedLabel={mixed}
              onCommit={(y) => update((d) => setFixturePosition(d, single.id, { y }))}
            />
          </div>
        )}
        <div data-testid="placement-row" className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("editor.stage.layout.height")}
            value={z}
            unit="m"
            mixedLabel={mixed}
            onCommit={(v) => update((d) => setFixturePlacement(d, fixtureIds, { z: v }))}
          />
          <NumberField
            label={t("editor.stage.layout.rotation")}
            value={rotation}
            unit="°"
            mixedLabel={mixed}
            onCommit={(v) => update((d) => setFixturePlacement(d, fixtureIds, { rotation: v }))}
          />
        </div>
        <div data-testid="placement-row" className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("editor.stage.layout.pitch")}
            value={pitch}
            unit="°"
            mixedLabel={mixed}
            onCommit={(v) => update((d) => setFixturePlacement(d, fixtureIds, { pitch: v }))}
          />
        </div>
        <div data-testid="placement-row" className="grid grid-cols-2 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{t("editor.stage.layout.hanging")}</span>
            <Switch
              aria-label={t("editor.stage.layout.hanging")}
              checked={hanging === true}
              onCheckedChange={(on) => update((d) => setFixturePlacement(d, fixtureIds, { hanging: on }))}
            />
            {hanging === MIXED && <span className="truncate">{mixed}</span>}
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 justify-self-end px-2 text-xs"
            onClick={() => update((d) => resetPlacements(d, fixtureIds))}
          >
            <RotateCcw aria-hidden />
            {t("editor.stage.layout.reset")}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("editor.patch.placementHint")}</p>
      </InspectorSection>

      {fixtures.length > 1 && (
        <InspectorSection scope="patch" id="sync" title={t("editor.patch.sections.sync")} defaultOpen={false}>
          <BatchSync fixtureIds={fixtureIds} />
        </InspectorSection>
      )}

      <InspectorSection scope="patch" id="groupsOf" title={t("editor.patch.sections.groupsOf")} aside={<span className="num">{groups.length}</span>}>
        {groups.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("editor.patch.notInGroup")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={selectedGroupId === g.id}
                onClick={() => {
                  setSelected(groupSelection(useProjectStore.getState().project, g.id));
                  selectGroup(g.id);
                }}
                title={t("editor.patch.groupChip", { name: g.name, count: g.fixtureIds.length })}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedGroupId === g.id ? "border-primary bg-primary/15" : "border-border hover:bg-surface-3",
                )}
              >
                {g.name} · <span className="num">{g.fixtureIds.length}</span>
              </button>
            ))}
          </div>
        )}
      </InspectorSection>
    </div>
  );
}
