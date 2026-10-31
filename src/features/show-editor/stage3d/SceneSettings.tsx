import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Settings2, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFixtureAssetStore } from "@/features/fixtures";
import { Segmented } from "@/shared/components/Segmented";
import { SliderField } from "../components/SliderField";
import { DEFAULT_HAZE, setStageHaze, setStageVenue, updateStageVenue } from "../lib/stageOps";
import { BEAM_QUALITIES, useEditorPrefsStore, type BeamQuality } from "../stores/useEditorPrefsStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageField } from "../stage/StageField";
import type { BeamTier } from "./quality";
import { VenueImportDialog } from "./VenueImportDialog";

/**
 * 3D 舞台的场景设置（HUD 上的弹层）：光束画质、烟雾浓度与场馆模型（导入、从资源库选、位置 / 角度 / 缩放、清除）。
 * 画质记在编辑器偏好里；烟雾与场馆跟着工程（一步撤销）。
 *
 * @param props.tier 自动画质当前用的档位（显示用）。
 * @param props.venueFailed 场馆模型加载失败。
 */
export function SceneSettings({ tier, venueFailed }: { tier: BeamTier; venueFailed: boolean }) {
  const { t } = useTranslation();
  const stage = useProjectStore((s) => s.project.stage);
  const update = useProjectStore((s) => s.update);
  const quality = useEditorPrefsStore((s) => s.stage.beamQuality);
  const setPrefs = useEditorPrefsStore((s) => s.setStagePrefs);
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const [importOpen, setImportOpen] = useState(false);
  const venues = [...byHash.values()].filter((a) => a.kind === "venue");
  const venue = stage.venue;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t("editor.stage3d.scene.title")}
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-background/60 px-2 text-[11px] text-muted-foreground backdrop-blur-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings2 aria-hidden className="size-3" />
            {t("editor.stage3d.scene.title")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="grid w-80 gap-3 p-3 text-xs">
          <div className="grid gap-1.5">
            <span className="font-medium">{t("editor.stage3d.scene.quality")}</span>
            <Segmented<BeamQuality>
              size="xs"
              ariaLabel={t("editor.stage3d.scene.quality")}
              value={quality}
              options={BEAM_QUALITIES.map((q) => ({ value: q, label: t(`editor.stage3d.scene.qualities.${q}`) }))}
              onChange={(q) => setPrefs({ beamQuality: q })}
            />
            <p className="text-muted-foreground">
              {quality === "auto" ? t("editor.stage3d.scene.autoNow", { tier: t(`editor.stage3d.scene.qualities.${tier}`) }) : t("editor.stage3d.scene.qualityHint")}
            </p>
          </div>
          <SliderField
            label={t("editor.stage3d.scene.haze")}
            numberLabel={t("editor.stage3d.scene.hazeValue")}
            value={Math.round((stage.haze ?? DEFAULT_HAZE) * 100)}
            min={0}
            max={100}
            unit="%"
            onCommit={(v) => update((d) => setStageHaze(d, v / 100))}
          />
          <div className="grid gap-1.5">
            <span className="flex items-center gap-1 font-medium">
              <Building2 aria-hidden className="size-3.5" />
              {t("editor.stage3d.venue.title")}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{venue ? venue.name || venue.hash.slice(0, 12) : t("editor.stage3d.venue.none")}</span>
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setImportOpen(true)}>
                <Upload aria-hidden className="size-3" />
                {t("editor.stage3d.venue.import")}
              </Button>
              {venue && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={t("editor.stage3d.venue.clear")}
                  title={t("editor.stage3d.venue.clear")}
                  onClick={() => update((d) => setStageVenue(d, null))}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
            {venues.length > 0 && (
              <Select
                value={venue?.hash ?? ""}
                onValueChange={(hash) => {
                  const a = byHash.get(hash);
                  if (a) update((d) => setStageVenue(d, { hash: a.hash, name: a.name }));
                }}
              >
                <SelectTrigger className="h-7 text-xs" aria-label={t("editor.stage3d.venue.choose")}>
                  <SelectValue placeholder={t("editor.stage3d.venue.choose")} />
                </SelectTrigger>
                <SelectContent>
                  {venues.map((a) => (
                    <SelectItem key={a.hash} value={a.hash}>
                      {a.name || a.hash.slice(0, 12)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {venue && (
              <div className="flex flex-wrap gap-1.5">
                {(["x", "y", "z"] as const).map((k) => (
                  <StageField
                    key={k}
                    label={t(`editor.stage3d.venue.${k}`)}
                    value={venue[k]}
                    unit="m"
                    onCommit={(v) => update((d) => updateStageVenue(d, { [k]: v }))}
                  />
                ))}
                <StageField
                  label={t("editor.stage3d.venue.rotation")}
                  value={venue.rotation}
                  unit="°"
                  onCommit={(v) => update((d) => updateStageVenue(d, { rotation: v }))}
                />
                <StageField
                  label={t("editor.stage3d.venue.scale")}
                  value={venue.scale}
                  unit="×"
                  onCommit={(v) => update((d) => updateStageVenue(d, { scale: v }))}
                />
              </div>
            )}
            {venue && venueFailed && (
              <p role="alert" className="text-destructive">
                {t("editor.stage3d.venue.failed")}
              </p>
            )}
            {venue && !byHash.has(venue.hash) && <p className="text-warning">{t("editor.stage3d.venue.missing")}</p>}
          </div>
        </PopoverContent>
      </Popover>
      {importOpen && <VenueImportDialog onClose={() => setImportOpen(false)} />}
    </>
  );
}
