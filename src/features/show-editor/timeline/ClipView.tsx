import { memo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Aperture, Focus, Move, Palette, Settings2, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { clipCategory, clipFill, clipName } from "../lib/clipVisual";
import type { LayerBadge } from "../lib/fixtureProfile";
import { lookKeyTimes } from "../lib/keyframes";
import { lookLayers, resolveLook } from "../lib/looks";
import { CUE_TAG_COLORS, type Cue, type Preset } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { useProjectStore } from "../stores/useProjectStore";
import { CLIP_CATEGORY_ACCENT } from "./clipCategoryStyle";
import { CueBlock } from "./CueBlock";

/** 片段宽度小于这个值时不显示裁剪手柄（避免抓不到片段本身）。 */
const MIN_HANDLE_WIDTH_PX = 18;

interface ClipViewProps {
  cue: Cue;
  /** 所在轨道名（无障碍名称用） */
  trackName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  selected: boolean;
  locked: boolean;
  dimmed: boolean;
  /** 所在轨道折叠：只画一条色带 */
  collapsed: boolean;
  /** 正在被拖动（预览位置） */
  dragging: boolean;
  /** 拖动预览放不下（与邻居重叠等） */
  invalid: boolean;
  presets: readonly Preset[];
  /** 工程 Gamma（手动覆盖颜色的合成用） */
  gamma: number;
  /** 实际输出色带（CSS 渐变，引擎采样）；尚未采样时为 `null` */
  strip: string | null;
  /** 外观片段用到的属性组（徽标） */
  badges?: readonly LayerBadge[];
  /** 外观里没有任何一台灯支持的层（警告） */
  unsupported?: readonly string[];
}

/** 属性徽标的图标。 */
const BADGE_ICONS: Record<LayerBadge, LucideIcon> = {
  color: Palette,
  position: Move,
  beam: Aperture,
  focus: Focus,
  control: Settings2,
};

/** 宽度不小于这个值时才画属性徽标。 */
const MIN_BADGE_WIDTH_PX = 44;

/** 色带高度（像素）。 */
const STRIP_HEIGHT = 6;

/**
 * 时间线上的一个片段（剪映式）：顶部类别色条（颜色 / 特效 / 预设 / 场景）+ 强度包络（`CueBlock`，
 * 含类型图标、名称、亮度）+ 底部实际输出色带 + 左右裁剪手柄。悬停提示类型、名称与用到的层。
 * 折叠的轨道只画一条色带。
 *
 * 指针交互由轨道区统一处理（事件委托），这里只用 `data-cue-id` / `data-edge` 标出命中区域。
 */
export const ClipView = memo(function ClipView({
  cue,
  trackName,
  left,
  top,
  width,
  height,
  selected,
  locked,
  dimmed,
  collapsed,
  dragging,
  invalid,
  presets,
  gamma,
  strip,
  badges,
  unsupported,
}: ClipViewProps) {
  const { t } = useTranslation();
  const tempo = useProjectStore((s) => s.project.tempo);
  const category = clipCategory(cue, presets);
  const kindName = t(`editor.timeline.clipKinds.${category}`);
  const name = clipName(cue, presets, (effect) => t(`editor.effects.${effect}`));
  const label = t("editor.timeline.clipLabel", {
    track: trackName,
    start: formatTimecode(cue.startMs),
    end: formatTimecode(cue.endMs),
    brightness: Math.round(cue.brightness),
  });
  const layerName = (k: string) =>
    k === "intensity" ? t("editor.look.intensity") : k === "color" ? t("editor.look.color") : t(`fixtures.functions.${k}`);
  const warn = unsupported && unsupported.length > 0 ? t("editor.timeline.clipUnsupported", { layers: unsupported.map(layerName).join("、") }) : null;
  // 悬停提示：类型 · 名称 · 用到的层
  const layers = cue.kind === "look" ? lookLayers(resolveLook(cue.look, presets)).map(layerName).join("、") : "";
  const tooltip = [kindName, name, layers ? t("editor.timeline.clipLayers", { layers }) : null].filter(Boolean).join(" · ");
  const fullLabel = [
    name ? t("editor.timeline.clipKindNamed", { kind: kindName, name }) : kindName,
    label,
    cue.tag ? t(`editor.tags.${cue.tag}`) : null,
    cue.disabled ? t("editor.timeline.clipDisabled") : null,
    warn,
  ]
    .filter(Boolean)
    .join(" · ");
  const tagColor = cue.tag ? CUE_TAG_COLORS[cue.tag] : null;
  const handles = !locked && !collapsed && width >= MIN_HANDLE_WIDTH_PX;
  const length = Math.max(1, cue.endMs - cue.startMs);
  // 外观片段的关键帧画成 ◆（宽度太窄时不画）
  const keyTimes = cue.kind === "look" && width >= MIN_HANDLE_WIDTH_PX ? lookKeyTimes(cue.look).filter((t) => t <= length) : [];

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={fullLabel}
      aria-pressed={selected}
      title={tooltip}
      data-cue-id={cue.id}
      data-category={category}
      data-disabled={cue.disabled ? "" : undefined}
      className={cn(
        "group absolute overflow-hidden rounded-[5px] border bg-surface-1/60",
        cue.disabled && "opacity-45 grayscale",
        locked ? "cursor-default" : "cursor-grab",
        selected ? "border-foreground ring-1 ring-foreground/70" : "border-border/70",
        dragging && "z-10 cursor-grabbing shadow-lg",
        invalid && "border-destructive ring-1 ring-destructive",
      )}
      style={{ left, top, width: Math.max(2, width), height }}
    >
      {collapsed ? (
        (() => {
          // 折叠：有实际输出色带时画色带，否则画设定颜色（没有颜色层时为中性斜纹）
          const fill = strip ? null : clipFill(cue, presets, { tempo, members: 1, gamma });
          return (
            <div
              aria-hidden
              className={cn("h-full w-full opacity-80", dimmed && "opacity-40", fill?.neutral && "hatch-neutral")}
              style={{ background: strip ?? fill?.background ?? undefined }}
            />
          );
        })()
      ) : (
        <>
          <span aria-hidden data-testid="clip-accent" className={cn("absolute inset-x-0 top-0 z-[1] h-0.5", CLIP_CATEGORY_ACCENT[category])} />
          <div className="absolute inset-x-0 top-0" style={{ bottom: strip ? STRIP_HEIGHT : 0 }}>
            <CueBlock cue={cue} dimmed={dimmed} locked={locked} selected={selected && !dragging} />
          </div>
          {keyTimes.map((tMs) => (
            // 可点的关键帧：点击把播放头移到这里，右键删除（命中区约 10 px，比 ◆ 本身大）
            <span
              key={tMs}
              aria-hidden
              data-testid="clip-key"
              data-key-ms={tMs}
              title={t("editor.keys.hint", { time: formatTimecode(cue.startMs + tMs) })}
              className="group/key absolute z-[2] flex size-2.5 -translate-x-1/2 cursor-pointer items-center justify-center"
              style={{ left: `${(tMs / length) * 100}%`, bottom: (strip ? STRIP_HEIGHT : 0) + 1 }}
            >
              <span className="size-2 rotate-45 border border-background bg-keyframe transition-transform group-hover/key:scale-125" />
            </span>
          ))}
          {strip && (
            <span
              aria-hidden
              data-testid="clip-strip"
              className={cn("absolute inset-x-0 bottom-0 bg-(--strip)", dimmed && "opacity-40")}
              style={{ height: STRIP_HEIGHT, "--strip": strip } as CSSProperties}
            />
          )}
        </>
      )}
      {tagColor && (
        <span
          aria-hidden
          data-testid="clip-tag"
          className="pointer-events-none absolute inset-y-0 left-0 z-[3] w-1 bg-(--tag-color)"
          style={{ "--tag-color": `rgb(${tagColor[0]} ${tagColor[1]} ${tagColor[2]})` } as CSSProperties}
        />
      )}
      {!collapsed && width >= MIN_BADGE_WIDTH_PX && (badges?.length || warn) && (
        <span aria-hidden data-testid="clip-badges" className="pointer-events-none absolute right-1 top-1 z-[3] flex items-center gap-0.5">
          {warn && (
            <span title={warn} data-testid="clip-warning" className="pointer-events-auto text-warning">
              <TriangleAlert className="size-3" />
            </span>
          )}
          {badges?.map((b) => {
            const Icon = BADGE_ICONS[b];
            return <Icon key={b} data-badge={b} className="size-3 text-foreground/70" />;
          })}
        </span>
      )}
      {cue.disabled && <span aria-hidden className="hatch-removed pointer-events-none absolute inset-0 z-[3] opacity-60" />}
      {handles && (
        <>
          <span
            aria-hidden
            data-edge="start"
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
          <span
            aria-hidden
            data-edge="end"
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
        </>
      )}
    </div>
  );
});
