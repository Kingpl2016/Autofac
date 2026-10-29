import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDefaultLayout } from "react-resizable-panels";
import { Group, ListPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { announce } from "@/shared/stores/announcerStore";
import { ensureFixtureTracks } from "../lib/fixtureBatch";
import { isPixelRef, pixelRefsOf } from "../lib/fixtureRef";
import { createGroup, ensureRefTracks, MIN_GROUP_SIZE } from "../lib/ops";
import { analyzePatch } from "../lib/patch";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { DmxChannelView } from "./DmxChannelView";
import { EmptyHint } from "./EmptyHint";
import { FixtureDetails } from "./FixtureDetails";
import { FixtureList } from "./FixtureList";
import { GroupList } from "./GroupList";
import { InspectorSection } from "./InspectorSection";
import { UniverseOverview } from "./UniverseOverview";

/**
 * “灯具与 Patch”面板（列表 + 详情，Figma / 剪映属性面板与 grandMA3 Patch 表的结合）：
 *
 * - 上：紧凑的灯具列表（搜索、只看有问题的、点选 / Ctrl / Shift 多选），时间线点轨道时会滚动到对应的灯；
 * - 下：没选中时是 Patch 概况（冲突提示、补建轨道、Universe 占用、DMX 通道、分组），
 *   选中后是“已选 N 台”的摘要、操作与按分区排列的属性；
 * - 两栏之间的分隔条可拖动，高度与各分区的展开状态都会记住。
 */
export function PatchPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedRaw = useEditorUiStore((s) => s.selectedFixtureIds);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "patch-split", storage: localStorage });

  const { fixtures, fixtureModels, tracks } = project;
  const status = useMemo(() => analyzePatch({ fixtures, fixtureModels }), [fixtures, fixtureModels]);
  const [dmxUniverse, setDmxUniverse] = useState<number | null>(null);
  // 选中的灯具可能已被删除（含撤销 / 重做之后），按当前工程过滤；按 Patch 列表顺序（批量操作的基准是第一台）
  const selected = useMemo(() => {
    const set = new Set(selectedRaw);
    return fixtures.filter((f) => set.has(f.id)).map((f) => f.id);
  }, [selectedRaw, fixtures]);
  // 选中的像素（像素引用），按 Patch 顺序与像素号排列
  const selectedPixels = useMemo(() => {
    const set = new Set(selectedRaw.filter(isPixelRef));
    return fixtures.flatMap((f) => pixelRefsOf({ fixtureModels }, f).filter((r) => set.has(r)));
  }, [selectedRaw, fixtures, fixtureModels]);
  // 没有轨道的灯具（旧工程或删了轨道后），可一键补建
  const missingTracks = useMemo(() => {
    const has = new Set(tracks.flatMap((tr) => (tr.target.kind === "fixture" ? [tr.target.id] : [])));
    return fixtures.filter((f) => !has.has(f.id)).length;
  }, [fixtures, tracks]);
  const conflictCount = useMemo(() => [...status.values()].filter((s) => s.conflictsWith.length > 0 || s.overflow).length, [status]);

  if (fixtures.length === 0) {
    return <EmptyHint>{t("editor.patch.empty")}</EmptyHint>;
  }

  return (
    <ResizablePanelGroup orientation="vertical" className="h-full min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="list" defaultSize="42%" minSize="20%">
        <section aria-label={t("editor.patch.fixtures")} className="h-full min-h-0">
          <FixtureList fixtures={fixtures} models={fixtureModels} status={status} selected={[...selected, ...selectedPixels]} />
        </section>
      </ResizablePanel>
      <ResizableHandle axis="y" />
      <ResizablePanel id="detail" minSize="25%">
        <div className="h-full overflow-auto" data-testid="patch-detail">
          {selectedPixels.length > 0 && <PixelSelection refs={selectedPixels} />}
          {selected.length > 0 ? (
            <FixtureDetails ids={selected} status={status} />
          ) : selectedPixels.length > 0 ? null : (
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
              <p className="text-sm font-medium">{t("editor.patch.overview")}</p>
              <p className="text-[11px] text-muted-foreground">{t("editor.patch.overviewHint")}</p>
              {conflictCount > 0 && (
                <p role="status" className="text-xs font-medium text-destructive">
                  {t("editor.patch.conflictSummary", { count: conflictCount })}
                </p>
              )}
              {missingTracks > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 self-start text-xs"
                  onClick={() => {
                    let n = 0;
                    update((d) => {
                      n = ensureFixtureTracks(d);
                    });
                    announce(t("editor.batch.tracksCreated", { count: n }));
                  }}
                >
                  <ListPlus aria-hidden />
                  {t("editor.batch.createTracks", { count: missingTracks })}
                </Button>
              )}
            </div>
          )}
          <InspectorSection scope="patch" id="universes" title={t("editor.patch.universes")}>
            <UniverseOverview selectedIds={selected} onPickUniverse={setDmxUniverse} />
          </InspectorSection>
          <InspectorSection scope="patch" id="channels" title={t("editor.dmx.title")} defaultOpen={false}>
            <DmxChannelView universe={dmxUniverse} onUniverseChange={setDmxUniverse} />
          </InspectorSection>
          {selected.length === 0 && (
            <InspectorSection scope="patch" id="groups" title={t("editor.patch.groups")} aside={<span className="num">{project.groups.length}</span>}>
              <GroupList />
            </InspectorSection>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/** 选中像素时的操作：为像素建轨道、用像素建组（一次操作一步撤销）。 */
function PixelSelection({ refs }: { refs: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const tracks = useProjectStore((s) => s.project.tracks);
  const missing = useMemo(() => {
    const has = new Set(tracks.flatMap((tr) => (tr.target.kind === "fixture" ? [tr.target.id] : [])));
    return refs.filter((r) => !has.has(r));
  }, [refs, tracks]);
  return (
    <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
      <p className="text-sm font-medium">{t("editor.patch.pixelsSelected", { count: refs.length })}</p>
      <p className="text-[11px] text-muted-foreground">{t("editor.patch.pixelsHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={missing.length === 0}
          onClick={() => {
            update((d) => void ensureRefTracks(d, missing));
            announce(t("editor.patch.pixelTracksCreated", { count: missing.length }));
          }}
        >
          <ListPlus aria-hidden />
          {t("editor.patch.pixelTracks")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={refs.length < MIN_GROUP_SIZE}
          onClick={() => {
            let created: string | null = null;
            update((d) => {
              created = createGroup(d, t("editor.patch.pixelGroupName", { n: d.groups.length + 1 }), refs);
            });
            if (created) announce(t("editor.patch.grouped", { count: refs.length }));
          }}
        >
          <Group aria-hidden />
          {t("editor.patch.pixelGroup")}
        </Button>
      </div>
    </div>
  );
}
