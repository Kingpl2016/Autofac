import { useTranslation } from "react-i18next";
import { Circle, Grid3x3, ImageMinus, ImagePlus, Minus, RectangleHorizontal, RotateCcw, Spline, Trash2, Type, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { pickImageFile } from "@/shared/tauri/pickers";
import { announce } from "@/shared/stores/announcerStore";
import { CommitInput } from "../components/CommitInput";
import { IMAGE_EXTENSIONS } from "../lib/mediaApi";
import type { StageObject } from "../lib/project";
import {
  addStageObject,
  arrangeFixtures,
  removeStageObject,
  resetPlacements,
  setFixturePlacement,
  setStageBackground,
  setStageSize,
  updateStageObject,
  type Arrangement,
} from "../lib/stageOps";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import type { StageBackgroundState } from "./useStageBackground";

/** 解析数字输入；不是有限数字时返回 `null`（不提交）。 */
function num(text: string): number | null {
  const v = Number(text.trim().replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

/** 紧凑数字输入：标签 + 提交式输入框 + 单位。 */
function Field({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span aria-hidden>{label}</span>
      <CommitInput
        label={label}
        value={Number(value.toFixed(2))}
        inputMode="numeric"
        className="num h-6 w-14 px-1 text-[11px]"
        onCommit={(text) => {
          const v = num(text);
          if (v !== null) onCommit(v);
        }}
      />
      <span aria-hidden>{unit}</span>
    </label>
  );
}

const OBJECT_KINDS: { kind: StageObject["kind"]; icon: typeof Minus }[] = [
  { kind: "truss", icon: Minus },
  { kind: "rect", icon: RectangleHorizontal },
  { kind: "circle", icon: Circle },
  { kind: "label", icon: Type },
];

interface StageLayoutBarProps {
  /** 选中的布景物件 */
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
  background: StageBackgroundState;
}

/**
 * 舞台布置工具条：添加布景物件、舞台尺寸、背景图；选中灯具时可设朝向 / 高度 / 吊挂、对齐排列、复位；
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

  const arrange = (how: Arrangement) => {
    // 按工程顺序排列（与选择工具的顺序一致）
    const ids = fixtures.filter((f) => selectedIds.includes(f.id)).map((f) => f.id);
    update((d) => arrangeFixtures(d, ids, how));
  };

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
        <Field label={t("editor.stage.layout.width")} value={stage.width} unit="m" onCommit={(v) => update((d) => setStageSize(d, v, d.stage.depth))} />
        <Field label={t("editor.stage.layout.depth")} value={stage.depth} unit="m" onCommit={(v) => update((d) => setStageSize(d, d.stage.width, v))} />
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
          <Field
            label={t("editor.stage.layout.rotation")}
            value={first.stage?.rotation ?? 0}
            unit="°"
            onCommit={(v) => update((d) => setFixturePlacement(d, selectedIds, { rotation: v }))}
          />
          <Field
            label={t("editor.stage.layout.height")}
            value={first.stage?.z ?? 0}
            unit="m"
            onCommit={(v) => update((d) => setFixturePlacement(d, selectedIds, { z: v }))}
          />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Switch
              aria-label={t("editor.stage.layout.hanging")}
              checked={first.stage?.hanging === true}
              onCheckedChange={(on) => update((d) => setFixturePlacement(d, selectedIds, { hanging: on }))}
            />
            <span aria-hidden>{t("editor.stage.layout.hanging")}</span>
          </label>
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
                onClick={() => arrange({ kind: "arc", sweepDeg: 90 })}
              >
                <Spline aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.arc")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => arrange({ kind: "grid", columns: Math.ceil(Math.sqrt(selected.length)) })}
              >
                <Grid3x3 aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.grid")}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => arrange({ kind: "circle" })}>
                <Circle aria-hidden className="size-3" />
                {t("editor.stage.layout.arrange.circle")}
              </Button>
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
          <Field label={t("editor.stage.layout.objectWidth")} value={object.w} unit="m" onCommit={(v) => update((d) => updateStageObject(d, object.id, { w: v }))} />
          {object.kind !== "circle" && (
            <Field
              label={t("editor.stage.layout.objectHeight")}
              value={object.h}
              unit="m"
              onCommit={(v) => update((d) => updateStageObject(d, object.id, { h: v }))}
            />
          )}
          <Field
            label={t("editor.stage.layout.rotation")}
            value={object.rotation}
            unit="°"
            onCommit={(v) => update((d) => updateStageObject(d, object.id, { rotation: v }))}
          />
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
