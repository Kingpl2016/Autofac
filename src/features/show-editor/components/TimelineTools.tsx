import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Crosshair, Magnet, Maximize2, Rows3, ArrowLeftToLine, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { setTrackView, TRACK_HEIGHT_ORDER } from "../lib/ops";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, sliderToZoom, ZOOM_SLIDER_STEPS, zoomPxPerSec, zoomToSlider } from "../lib/zoom";
import { SNAP_KINDS, useEditorPrefsStore, type RulerFormat } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { TimelineLegend } from "./TimelineLegend";

/** 工具条上的小图标按钮（按下态用 `aria-pressed`，不只靠颜色）。 */
function ToolButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-6", pressed && "bg-primary/20 text-primary")}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * 时间线头部右侧的工具：吸附开关与吸附目标、波纹编辑、跟随播放头、轨道高度（全部轨道）、标尺刻度、
 * 缩放滑块（对数刻度）与“适应窗口”。设置会记住（编辑器偏好）。
 */
export function TimelineTools({ commands }: { commands: readonly Command[] }) {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const setPxPerSec = useEditorUiStore((s) => s.setPxPerSec);
  const snapEnabled = useEditorUiStore((s) => s.snapEnabled);
  const toggleSnap = useEditorUiStore((s) => s.toggleSnap);
  const snapKinds = useEditorPrefsStore((s) => s.snapKinds);
  const setSnapKind = useEditorPrefsStore((s) => s.setSnapKind);
  const ripple = useEditorPrefsStore((s) => s.rippleEdit);
  const setRipple = useEditorPrefsStore((s) => s.setRippleEdit);
  const follow = useEditorPrefsStore((s) => s.followPlayhead);
  const setFollow = useEditorPrefsStore((s) => s.setFollowPlayhead);
  const rulerFormat = useEditorPrefsStore((s) => s.rulerFormat);
  const setRulerFormat = useEditorPrefsStore((s) => s.setRulerFormat);
  const hasTempo = useProjectStore((s) => s.project.tempo !== null);
  const update = useProjectStore((s) => s.update);
  const tracks = useProjectStore((s) => s.project.tracks);

  const zoomFit = () => commands.find((c) => c.id === "view.zoomFit")?.run();
  // 全部轨道的高度：取第一条轨道的档位作为当前值
  const height = tracks[0]?.height ?? "normal";
  const allCollapsed = tracks.length > 0 && tracks.every((tr) => tr.collapsed);
  const setAll = (view: Parameters<typeof setTrackView>[2]) =>
    update((d) => {
      for (const tr of d.tracks) setTrackView(d, tr.id, view);
    });

  return (
    <div role="toolbar" aria-label={t("editor.timelineTools.label")} className="flex items-center gap-0.5">
      <div className="flex items-center">
        <ToolButton label={snapEnabled ? t("editor.timeline.snapOn") : t("editor.timeline.snapOff")} onClick={toggleSnap} pressed={snapEnabled}>
          <Magnet aria-hidden />
        </ToolButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-4" aria-label={t("editor.timelineTools.snapOptions")} title={t("editor.timelineTools.snapOptions")}>
              <ChevronDown aria-hidden className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label={t("editor.timelineTools.snapOptions")}>
            <DropdownMenuLabel>{t("editor.timelineTools.snapTo")}</DropdownMenuLabel>
            {SNAP_KINDS.map((k) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={snapKinds[k]}
                disabled={k === "beats" && !hasTempo}
                onCheckedChange={(on) => setSnapKind(k, on === true)}
                onSelect={(e) => e.preventDefault()}
              >
                {t(`editor.timelineTools.snapKinds.${k}`)}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <p className="px-2.5 py-1 text-[11px] text-muted-foreground">{t("editor.timelineTools.snapHint")}</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ToolButton
        label={t("editor.timelineTools.ripple")}
        pressed={ripple}
        onClick={() => {
          setRipple(!ripple);
          announce(t(ripple ? "editor.timelineTools.rippleOff" : "editor.timelineTools.rippleOn"));
        }}
      >
        <ArrowLeftToLine aria-hidden />
      </ToolButton>
      <ToolButton label={t("editor.timelineTools.follow")} pressed={follow} onClick={() => setFollow(!follow)}>
        <Crosshair aria-hidden />
      </ToolButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t("editor.timelineTools.trackHeight")} title={t("editor.timelineTools.trackHeight")} disabled={tracks.length === 0}>
            <Rows3 aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={t("editor.timelineTools.trackHeight")}>
          <DropdownMenuLabel>{t("editor.timelineTools.allTracks")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={height} onValueChange={(v) => setAll({ height: v as (typeof TRACK_HEIGHT_ORDER)[number] })}>
            {TRACK_HEIGHT_ORDER.map((h) => (
              <DropdownMenuRadioItem key={h} value={h}>
                {t(`editor.timelineTools.heights.${h}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAll({ collapsed: !allCollapsed })}>
            {allCollapsed ? t("editor.timelineTools.expandAll") : t("editor.timelineTools.collapseAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Segmented<RulerFormat>
        size="xs"
        className="mx-1"
        ariaLabel={t("editor.timelineTools.ruler")}
        value={hasTempo ? rulerFormat : "timecode"}
        onChange={setRulerFormat}
        options={[
          { value: "timecode", label: t("editor.timelineTools.timecode"), title: t("editor.timelineTools.timecodeHint") },
          { value: "bars", label: t("editor.timelineTools.bars"), title: hasTempo ? t("editor.timelineTools.barsHint") : t("editor.timelineTools.needTempo"), disabled: !hasTempo },
        ]}
      />
      <ToolButton label={t("editor.timeline.zoomOut")} onClick={() => setPxPerSec(zoomPxPerSec(pxPerSec, -1))} disabled={pxPerSec <= MIN_PX_PER_SEC}>
        <ZoomOut aria-hidden />
      </ToolButton>
      <Slider
        className="w-20"
        min={0}
        max={ZOOM_SLIDER_STEPS}
        step={1}
        value={[zoomToSlider(pxPerSec)]}
        onValueChange={([v]) => setPxPerSec(sliderToZoom(v))}
        thumbLabel={t("editor.timelineTools.zoom")}
        aria-valuetext={t("editor.timelineTools.zoomValue", { value: pxPerSec })}
      />
      <ToolButton label={t("editor.timeline.zoomIn")} onClick={() => setPxPerSec(zoomPxPerSec(pxPerSec, 1))} disabled={pxPerSec >= MAX_PX_PER_SEC}>
        <ZoomIn aria-hidden />
      </ToolButton>
      <ToolButton label={t("editor.timelineTools.fit")} onClick={zoomFit}>
        <Maximize2 aria-hidden />
      </ToolButton>
      <TimelineLegend />
    </div>
  );
}
