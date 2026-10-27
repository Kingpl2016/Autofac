import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { useCueActions } from "../hooks/useCueActions";
import { CUE_TEMPLATES, cssColor, type CueTemplate } from "../lib/cueTemplates";
import { templateStyle } from "../timeline/dropTemplate";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 拖拽数据：标明被拖的是 Cue 模板。 */
export interface TemplateDragData {
  kind: "template";
  template: CueTemplate;
}

interface TemplateChipProps {
  template: CueTemplate;
  /** 不可交互的预览（拖拽时跟随指针的浮层用） */
  overlay?: boolean;
}

/** 模板芯片：色块 + 名称。 */
export function TemplateChip({ template, overlay }: TemplateChipProps) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm",
        overlay && "border-primary shadow-lg",
      )}
    >
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-sm border border-border bg-(--cue-color)"
        style={{ "--cue-color": cssColor(template.rgb) } as CSSProperties}
      />
      <span className="truncate">{t(`editor.templates.${template.id}`)}</span>
    </span>
  );
}

/** 一个模板：可以用指针拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处。 */
function DraggableTemplate({ template, onActivate }: { template: CueTemplate; onActivate: () => void }) {
  const { t } = useTranslation();
  const data: TemplateDragData = { kind: "template", template };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `template:${template.id}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      onClick={onActivate}
      title={t("editor.templates.hint")}
      className={cn(
        "cursor-grab rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
    >
      <TemplateChip template={template} />
    </button>
  );
}

/**
 * 素材库的“Cue 模板”标签：预设颜色场景。
 *
 * 拖到轨道上放下，或点击把它加到所选轨道（没有选中轨道时用第一条未锁定的轨道）的播放头处。
 */
export function TemplatesTab() {
  const { t } = useTranslation();
  const actions = useCueActions();

  const addToSelectedTrack = (template: CueTemplate) => {
    const { tracks } = useProjectStore.getState().project;
    const { selectedTrackId, playheadMs } = useEditorUiStore.getState();
    const track =
      tracks.find((tr) => tr.id === selectedTrackId && !tr.lock) ?? tracks.find((tr) => !tr.lock);
    if (!track) {
      announce(t("editor.templates.noTrack"));
      return;
    }
    const id = actions.addAt(track.id, playheadMs, templateStyle(template));
    announce(id ? t("editor.templates.added") : t("editor.templates.noRoom"));
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t("editor.templates.hint")}</p>
      <ul className="grid grid-cols-2 gap-1.5">
        {CUE_TEMPLATES.map((template) => (
          <li key={template.id}>
            <DraggableTemplate template={template} onActivate={() => addToSelectedTrack(template)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
