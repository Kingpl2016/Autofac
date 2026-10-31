import { useEffect, useId, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, Plus, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { channelCount, FixtureModelIcon, type FixtureModel, type FixtureType } from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { addModelToShow } from "../hooks/fixtureAddActions";
import { useEditorPrefsStore, type FixtureLibraryDensity } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { FixtureAddPanel } from "./FixtureAddPanel";
import type { FixtureModelDragData } from "./LibraryFixturesTab";

/**
 * 每种灯具类型的图标底色与图标色（取图表色板里的色相，类名写成完整字面量，Tailwind 才能扫描到）。
 * 只用来区分类型，不承载状态语义。
 */
const FIXTURE_TYPE_TINT: Record<FixtureType, string> = {
  mover: "bg-chart-1/15 text-chart-1",
  mixing: "bg-chart-2/15 text-chart-2",
  white: "bg-chart-3/15 text-chart-3",
  dimmer: "bg-chart-4/15 text-chart-4",
  other: "bg-muted text-muted-foreground",
};

interface FixtureModelCardProps {
  model: FixtureModel;
  type: FixtureType;
  /** 所在分区（拖拽 id 要在页面内唯一：同一模型可能同时出现在收藏、最近与类型分组里） */
  section: string;
  density: FixtureLibraryDensity;
  /** 是否提供批量添加面板（只在类型分组里提供，避免同一面板在多处同时展开） */
  batch: boolean;
}

/**
 * 一个灯具模型卡片：整行可拖（到 Patch / 舞台 / 时间线）；左侧类型色块点开看通道表；
 * 右侧常驻收藏、“+”快速加 1 台与批量添加（不靠悬停才出现）。
 */
export function FixtureModelCard({ model, type, section, density, batch }: FixtureModelCardProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const itemRef = useRef<HTMLLIElement>(null);
  const expanded = useEditorUiStore((s) => batch && s.fixtureAddModelId === model.id);
  const setExpanded = useEditorUiStore((s) => s.setFixtureAddModel);
  const favorite = useEditorPrefsStore((s) => s.fixtureLibrary.favorites.includes(model.id));
  const setFavorite = useEditorPrefsStore((s) => s.setFixtureFavorite);
  const data: FixtureModelDragData = { kind: "fixtureModel", modelId: model.id, name: model.name, type };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `fixtureModel:${section}:${model.id}`, data });
  const compact = density === "compact";
  const modes = 1 + (model.modes?.length ?? 0);
  const channels = channelCount(model);

  // 展开时（包括从灯具素材库跳转过来）把卡片滚到可见处
  useEffect(() => {
    if (expanded) itemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);

  const meta = [
    model.manufacturer || t(`fixtures.type.${type}`),
    modes > 1 ? t("editor.fixtureAdd.modes", { count: modes }) : null,
  ].filter(Boolean);
  const dragHint = t("editor.fixtureAdd.drag", { name: model.name });

  return (
    <li
      ref={itemRef}
      data-model-id={model.id}
      className={cn(
        "rounded-lg border bg-card transition-colors",
        expanded ? "border-primary/60 shadow-sm" : "border-border hover:border-muted-foreground/40 hover:bg-surface-3/40",
      )}
    >
      {/* 整行都能拖；行内按钮的点击不受影响（移动 6px 才算拖拽） */}
      <div
        ref={setNodeRef}
        {...listeners}
        title={dragHint}
        data-testid="fixture-model-drag"
        className={cn(
          "flex cursor-grab items-center gap-2 pr-1 active:cursor-grabbing",
          compact ? "py-1 pl-1" : "py-1.5 pl-1.5",
          isDragging && "opacity-40",
        )}
      >
        <FixtureChannelsPopover model={model} type={type}>
          <button
            type="button"
            aria-label={t("editor.library.channelsOf", { name: model.name })}
            title={t("editor.library.channelsOf", { name: model.name })}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md transition-[filter] hover:brightness-125",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "size-6" : "size-8",
              FIXTURE_TYPE_TINT[type],
            )}
          >
            <FixtureModelIcon model={model} labelled={false} className={compact ? "size-3.5" : "size-4"} />
          </button>
        </FixtureChannelsPopover>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] leading-tight font-medium" title={model.name}>
              {model.name}
            </span>
            <span
              className="num shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground"
              aria-label={t("fixtures.list.channels", { count: channels })}
            >
              {t("editor.library.channelsShort", { count: channels })}
            </span>
          </span>
          {!compact && (
            <span className="num mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground" title={model.id}>
              {meta.join(" · ")}
            </span>
          )}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-6 shrink-0", favorite ? "text-warning" : "text-muted-foreground")}
          aria-pressed={favorite}
          aria-label={t(favorite ? "editor.library.unfavorite" : "editor.library.favorite", { name: model.name })}
          title={t(favorite ? "editor.library.unfavorite" : "editor.library.favorite", { name: model.name })}
          onClick={() => void setFavorite(model.id, !favorite)}
        >
          <Star aria-hidden className={cn("size-3.5", favorite && "fill-current")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("editor.library.addAria", { name: model.name, count: 1 })}
          title={t("editor.library.addAria", { name: model.name, count: 1 })}
          onClick={() => addModelToShow(model, { count: 1 })}
        >
          <Plus aria-hidden />
        </Button>
        {batch && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            aria-label={t("editor.fixtureAdd.batch", { name: model.name })}
            title={t("editor.fixtureAdd.batch", { name: model.name })}
            onClick={() => setExpanded(expanded ? null : model.id)}
          >
            <ChevronDown aria-hidden className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
          </Button>
        )}
      </div>
      {expanded && <FixtureAddPanel id={panelId} model={model} />}
    </li>
  );
}

/**
 * 模型的通道表弹层：类型、厂商、通道数与默认模式下每个通道的名称和功能。
 * 弹层打开时点击 / 拖动不会被卡片的拖拽接管（指针事件在弹层里停止冒泡）。
 */
function FixtureChannelsPopover({ model, type, children }: { model: FixtureModel; type: FixtureType; children: ReactElement }) {
  const { t } = useTranslation();
  const rows = [...model.properties].sort((a, b) => a.channel - b.channel);
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-72 p-0"
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={t("editor.library.channelsOf", { name: model.name })}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", FIXTURE_TYPE_TINT[type])} aria-hidden>
            <FixtureModelIcon model={model} labelled={false} className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{model.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {[t(`fixtures.type.${type}`), model.manufacturer, model.defaultModeName, t("fixtures.list.channels", { count: channelCount(model) })]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-popover text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="w-10 px-3 py-1 text-right font-normal">{t("editor.library.channelCol")}</th>
                <th scope="col" className="px-2 py-1 text-left font-normal">{t("editor.library.nameCol")}</th>
                <th scope="col" className="px-3 py-1 text-left font-normal">{t("editor.library.functionCol")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.channel}-${p.code}`} className="border-t border-border/60">
                  <td className="num px-3 py-1 text-right text-muted-foreground">
                    {p.width === 2 ? `${p.channel}–${p.channel + 1}` : p.channel}
                  </td>
                  <td className="max-w-0 truncate px-2 py-1" title={p.name}>{p.name}</td>
                  <td className="px-3 py-1 text-muted-foreground">{t(`fixtures.functions.${p.function}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PopoverContent>
    </Popover>
  );
}
