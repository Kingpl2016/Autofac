import { useTranslation } from "react-i18next";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeftRight,
  ArrowRightLeft,
  ArrowUpDown,
  ChartNoAxesColumnIncreasing,
  Circle,
  Cylinder,
  Grid3x3,
  ImageMinus,
  ImagePlus,
  Minus,
  Monitor,
  Pentagon,
  RectangleHorizontal,
  RotateCcw,
  Spline,
  Trash2,
  Type,
  Waypoints,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { pickImageFile } from "@/shared/tauri/pickers";
import { announce } from "@/shared/stores/announcerStore";
import { CommitInput } from "../components/CommitInput";
import { IMAGE_EXTENSIONS } from "../lib/mediaApi";
import type { StageObject } from "../lib/project";
import {
  addStageObject,
  alignFixtures,
  arrangeFixtures,
  distributeFixtures,
  mirrorFixtures,
  objectHeight,
  removeStageObject,
  resetPlacements,
  reverseFixturePositions,
  setFixturePlacement,
  setStageBackground,
  setStageHeight,
  setStageSize,
  updateStageObject,
  type AlignMode,
  type Arrangement,
  type StageAxis,
} from "../lib/stageOps";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageField } from "./StageField";
import { StageObjectExtras, TrussHangTools } from "./StageObjectExtras";
import type { StageBackgroundState } from "./useStageBackground";

const OBJECT_KINDS: { kind: StageObject["kind"]; icon: typeof Minus }[] = [
  { kind: "truss", icon: Minus },
  { kind: "rect", icon: RectangleHorizontal },
  { kind: "circle", icon: Circle },
  { kind: "polygon", icon: Pentagon },
  { kind: "stairs", icon: ChartNoAxesColumnIncreasing },
  { kind: "pillar", icon: Cylinder },
  { kind: "screen", icon: Monitor },
  { kind: "label", icon: Type },
];

interface StageLayoutBarProps {
  /** 选中的布景物件 */
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
  background: StageBackgroundState;
}

/**
 * 舞台布置工具条：添加布景物件、舞台尺寸、背景图；选中灯具时可设朝向 / 高度 / 吊挂、排列（弧线张角与网格列数记在偏好里）、
 * 对齐（左 / 中 / 右 / 后 / 中 / 前）、等距分布、左右 / 前后镜像、反转顺序、复位；
 * 选中物件时可改文字、尺寸、角度或删除。所有修改都是一步撤销。
 */
export function StageLayoutBar({ selectedObjectId, onSelectObject, background }: StageLayoutBarProps) {
  const { t } = useTranslation();
  const stage = useProjectStore((s) => s.project.stage);
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const update = useProjectStore((s) => s.update);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const selected = fixtures.filter((f) => selectedIds.includes(f.id));
  const first = selected[0];
  const object = stage.objects.find((o) => o.id === selectedObjectId);

  const add = (kind: StageObject["kind"]) => {
    let id = "";
    update((d) => {
      id = addStageObject(d, kind, undefined, kind === "label" ? t("editor.stage.layout.labelDefault") : "");
    });
    onSelectObject(id);
    announce(t("editor.stage.layout.added", { kind: t(`editor.stage.layout.kinds.${kind}`) }));
  };

  const pickBackground = async () => {
    const path = await pickImageFile(t("editor.stage.layout.imageFilter"), IMAGE_EXTENSIONS);
    if (path) update((d) => setStageBackground(d, path));
  };

  // 按工程顺序（与选择工具的顺序一致）
  const orderedIds = () => fixtures.filter((f) => selectedIds.includes(f.id)).map((f) => f.id);
  const arrange = (how: Arrangement) => {
    const ids = orderedIds();
    update((d) => arrangeFixtures(d, ids, how));
  };
  const prefs = useEditorPrefsStore((s) => s.stage);
  const setPrefs = useEditorPrefsStore((s) => s.setStagePrefs);
  const columns = prefs.gridColumns > 0 ? prefs.gridColumns : Math.ceil(Math.sqrt(selected.length));
  /** 一个图标按钮（对齐 / 分布 / 镜像）。 */
  const iconTool = (label: string, Icon: typeof Minus, run: () => void, disabled = false) => (
    <Button
      key={label}
      type="button"
      size="icon"
      variant="ghost"
      className="size-6 [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        run();
        announce(label);
      }}
    >
      <Icon aria-hidden />
    </Button>
  );
  const ALIGN: { mode: AlignMode; icon: typeof Minus }[] = [
    { mode: "left", icon: AlignStartVertical },
    { mode: "centerX", icon: AlignCenterVertical },
    { mode: "right", icon: AlignEndVertical },
    { mode: "back", icon: AlignStartHorizontal },
    { mode: "centerY", icon: AlignCenterHorizontal },
    { mode: "front", icon: AlignEndHorizontal },
  ];
  const DISTRIBUTE: { axis: StageAxis; icon: typeof Minus }[] = [
    { axis: "x", icon: AlignHorizontalDistributeCenter },
    { axis: "y", icon: AlignVerticalDistributeCenter },
  ];
  const MIRROR: { axis: StageAxis; icon: typeof Minus }[] = [
    { axis: "x", icon: ArrowLeftRight },
    { axis: "y", icon: ArrowUpDown },
  ];

  return (
    <div className="flex flex-col gap-1 border-t border-border bg-background/85 px-2 py-1.5 backdrop-blur-sm">
      <div role="toolbar" aria-label={t("editor.stage.layout.toolbar")} className="flex flex-wrap items-center gap-1.5">
        {OBJECT_KINDS.map(({ kind, icon: Icon }) => (
          <Button key={kind} type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => add(kind)}>
            <Icon aria-hidden className="size-3" />
            {t(`editor.stage.layout.add.${kind}`)}
          </Button>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <StageField label={t("editor.stage.layout.width")} value={stage.width} unit="m" onCommit={(v) => update((d) => setStageSize(d, v, d.stage.depth))} />
        <StageField label={t("editor.stage.layout.depth")} value={stage.depth} unit="m" onCommit={(v) => update((d) => setStageSize(d, d.stage.width, v))} />
        <StageField label={t("editor.stage.layout.deckHeight")} value={stage.height ?? 0} unit="m" onCommit={(v) => update((d) => setStageHeight(d, v))} />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => void pickBackground()}>
          <ImagePlus aria-hidden className="size-3" />
          {t("editor.stage.layout.background")}
        </Button>
        {stage.backgroundPath && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => update((d) => setStageBackground(d, null))}
          >
            <ImageMinus aria-hidden className="size-3" />
            {t("editor.stage.layout.clearBackground")}
          </Button>
        )}
        {background.status === "error" && (
          <span role="alert" className="text-[11px] text-destructive">
            {t("editor.stage.layout.backgroundFailed")}
          </span>
        )}
      </div>

      {first && (
        <div role="group" aria-label={t("editor.stage.layout.fixtures", { count: selected.length })} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium">{t("editor.stage.layout.fixtures", { count: selected.length })}</span>
          <StageField
            label={t("editor.stage.layout.rotation")}
            value={first.stage?.rotation ?? 0}
            unit="°"
            onCommit={(v) => update((d) => setFixturePlacement(d, selectedIds, { rotation: v }))}
          />
          <StageField
            label={t("editor.stage.layout.height")}
            value={first.stage?.z ?? 0}
            unit="m"
            onCommit={(v) => update((d) => setFixturePlacement(d, selectedIds, { z: v }))}
          />
          <StageField
            label={t("editor.stage.layout.pitch")}
            value={first.stage?.pitch ?? 0}
            unit="°"
            onCommit={(v) => update((d) => setFixturePlacement(d, selectedIds, { pitch: v }))}
          />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Switch
              aria-label={t("editor.stage.layout.hanging")}
              checked={first.stage?.hanging === true}
              onCheckedChange={(on) => update((d) => setFixturePlacement(d, selectedIds, { hanging: on }))}
            />
            <span aria-hidden>{t("editor.stage.layout.hanging")}</span>
          </label>
          <TrussHangTools fixtureIds={orderedIds()} />
          {selected.length >= 2 && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => arrange({ kind: "line" })}>
                <Waypoints aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.line")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => arrange({ kind: "arc", sweepDeg: prefs.arcSweep })}
              >
                <Spline aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.arc")}
              </Button>
              <StageField label={t("editor.stage.layout.arcSweep")} value={prefs.arcSweep} unit="°" onCommit={(v) => setPrefs({ arcSweep: v })} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => arrange({ kind: "grid", columns })}
              >
                <Grid3x3 aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.grid")}
              </Button>
              <StageField label={t("editor.stage.layout.gridColumns")} value={columns} unit={t("editor.stage.layout.columnsUnit")} onCommit={(v) => setPrefs({ gridColumns: v })} />
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => arrange({ kind: "circle" })}>
                <Circle aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.circle")}
              </Button>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              <span role="group" aria-label={t("editor.stage.layout.alignGroup")} className="flex items-center">
                {ALIGN.map(({ mode, icon }) => iconTool(t(`editor.stage.layout.align.${mode}`), icon, () => update((d) => alignFixtures(d, selectedIds, mode))))}
              </span>
              <span role="group" aria-label={t("editor.stage.layout.distributeGroup")} className="flex items-center">
                {DISTRIBUTE.map(({ axis, icon }) =>
                  iconTool(t(`editor.stage.layout.distribute.${axis}`), icon, () => update((d) => distributeFixtures(d, selectedIds, axis)), selected.length < 3),
                )}
                {MIRROR.map(({ axis, icon }) => iconTool(t(`editor.stage.layout.mirror.${axis}`), icon, () => update((d) => mirrorFixtures(d, selectedIds, axis))))}
                {iconTool(t("editor.stage.layout.reverse"), ArrowRightLeft, () => {
                  const ids = orderedIds();
                  update((d) => reverseFixturePositions(d, ids));
                })}
              </span>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={() => update((d) => resetPlacements(d, selectedIds))}
          >
            <RotateCcw aria-hidden className="size-3" />
            {t("editor.stage.layout.reset")}
          </Button>
        </div>
      )}

      {object && (
        <div role="group" aria-label={t("editor.stage.layout.object")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium">{t(`editor.stage.layout.kinds.${object.kind}`)}</span>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span aria-hidden>{t("editor.stage.layout.text")}</span>
            <CommitInput
              label={t("editor.stage.layout.text")}
              value={object.label}
              className="h-6 w-28 px-1 text-[11px]"
              onCommit={(text) => update((d) => updateStageObject(d, object.id, { label: text }))}
            />
          </label>
          <StageField label={t("editor.stage.layout.objectWidth")} value={object.w} unit="m" onCommit={(v) => update((d) => updateStageObject(d, object.id, { w: v }))} />
          {object.kind !== "circle" && object.kind !== "pillar" && (
            <StageField
              label={t("editor.stage.layout.objectHeight")}
              value={object.h}
              unit="m"
              onCommit={(v) => update((d) => updateStageObject(d, object.id, { h: v }))}
            />
          )}
          <StageField
            label={t("editor.stage.layout.rotation")}
            value={object.rotation}
            unit="°"
            onCommit={(v) => update((d) => updateStageObject(d, object.id, { rotation: v }))}
          />
          {object.kind !== "label" && (
            <>
              <StageField
                label={t("editor.stage.layout.objectZ")}
                value={object.z ?? 0}
                unit="m"
                onCommit={(v) => update((d) => updateStageObject(d, object.id, { z: v }))}
              />
              <StageField
                label={t("editor.stage.layout.objectThickness")}
                value={objectHeight(object)}
                unit="m"
                onCommit={(v) => update((d) => updateStageObject(d, object.id, { height: v }))}
              />
            </>
          )}
          <StageObjectExtras object={object} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px] text-destructive"
            onClick={() => {
              update((d) => removeStageObject(d, object.id));
              onSelectObject(null);
            }}
          >
            <Trash2 aria-hidden className="size-3" />
            {t("editor.stage.layout.removeObject")}
          </Button>
        </div>
      )}
    </div>
  );
}
