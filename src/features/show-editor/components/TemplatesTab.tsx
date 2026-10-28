import { useId, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets, useTargetCapabilities } from "../hooks/useTargetCapabilities";
import { applicability, templateNeeds, type Applicability } from "../lib/cueDefaults";
import { CUE_TEMPLATES, cssColor, type CueTemplate } from "../lib/cueTemplates";
import { templateStyle } from "../timeline/dropTemplate";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ApplyBadge } from "./ApplyBadge";

/** 拖拽数据：标明被拖的是 Cue 模板。 */
export interface TemplateDragData {
  kind: "template";
  template: CueTemplate;
}

interface TemplateChipProps {
  template: CueTemplate;
  /** 不可交互的预览（拖拽时跟随指针的浮层用） */
  overlay?: boolean;
  /** 对所选轨道的适用情况 */
  app?: Applicability | null;
  /** 适用提示的元素 id */
  badgeId?: string;
}

/** 模板芯片：色块 + 名称（+ 适用提示）。 */
export function TemplateChip({ template, overlay, app, badgeId }: TemplateChipProps) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm",
        overlay && "border-primary shadow-lg",
        app?.level === "none" && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-sm border border-border bg-(--cue-color)"
        style={{ "--cue-color": cssColor(template.rgb) } as CSSProperties}
      />
      <span className="min-w-0 flex-1 truncate">{t(`editor.templates.${template.id}`)}</span>
      <ApplyBadge app={app ?? null} id={badgeId} />
    </span>
  );
}

/** 一个模板：可以用指针拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处。 */
function DraggableTemplate({
  template,
  app,
  onActivate,
}: {
  template: CueTemplate;
  app: Applicability | null;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const badgeId = useId();
  const data: TemplateDragData = { kind: "template", template };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `template:${template.id}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      onClick={onActivate}
      title={t("editor.templates.hint")}
      aria-label={t(`editor.templates.${template.id}`)}
      aria-describedby={app && app.level !== "full" ? badgeId : undefined}
      className={cn(
        "w-full cursor-grab rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
    >
      <TemplateChip template={template} app={app} badgeId={badgeId} />
    </button>
  );
}

/**
 * 素材库的“Cue 模板”标签：预设颜色场景。
 *
 * 拖到轨道上放下，或点击把它加到所选轨道（没有选中轨道时用第一条未锁定的轨道）的播放头处；
 * 多选了轨道时加到每条选中的轨道。新片段是外观片段，按灯具类型只写支持的层；
 * 彩色模板对不能混色的灯“不适用”（变灰并说明原因，点击 / 拖放会被拒绝）。
 */
export function TemplatesTab() {
  const { t } = useTranslation();
  const actions = useCueActions();
  const caps = useTargetCapabilities();

  const addToSelectedTrack = (template: CueTemplate) => {
    const needs = templateNeeds(template);
    const { all, supported } = supportedTargets(useProjectStore.getState().project, useEditorUiStore.getState(), needs);
    if (all.length === 0) {
      announce(t("editor.templates.noTrack"));
      return;
    }
    if (supported.length === 0) {
      announce(t("editor.apply.rejected", { reason: t(`editor.apply.needs.${needs}`) }));
      return;
    }
    // 多选了轨道时加到每条支持的轨道（一步撤销）
    const created = actions.addAtTracks(supported, useEditorUiStore.getState().playheadMs, templateStyle(template));
    if (supported.length === 1) announce(created.length > 0 ? t("editor.templates.added") : t("editor.templates.noRoom"));
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t("editor.templates.hint")}</p>
      <ul className="grid grid-cols-2 gap-1.5">
        {CUE_TEMPLATES.map((template) => (
          <li key={template.id}>
            <DraggableTemplate
              template={template}
              app={caps.length > 0 ? applicability(caps, templateNeeds(template)) : null}
              onActivate={() => addToSelectedTrack(template)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
