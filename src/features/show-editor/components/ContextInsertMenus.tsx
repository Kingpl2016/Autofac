import { useEffect, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";

import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { announce } from "@/shared/stores/announcerStore";
import { BUILTIN_GROUPS, cssColor, groupTemplates, templateName, templateRgb, type CueTemplate } from "../lib/cueTemplates";
import { addEffectDefCue, defaultEffectParams, effectName, groupEffects, sanitizeEffectParams } from "../lib/effectLibrary";
import type { EffectDef } from "../lib/effectDefSchema";
import type { ShowProject } from "../lib/project";
import { addTemplateCue } from "../lib/templateOps";
import { allTemplates, useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { allEffects, useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { EFFECT_ICONS } from "./effectIcons";

/** 插入的位置：右键的轨道与时刻。 */
interface InsertAt {
  trackId: string | null;
  timeMs: number;
  disabled: boolean;
}

/** 子菜单很长时可以滚动，不超出屏幕。 */
const SCROLL_CONTENT = "max-h-[min(24rem,70vh)] overflow-y-auto";

/**
 * 在轨道上新建一个片段并选中它（一步撤销）；放不下时提示。
 *
 * @param make 在草稿里新建片段，返回 id（放不下时 `null`）。
 * @param noRoom 放不下时的提示。
 */
function insertAndSelect(make: (d: ShowProject) => string | null, noRoom: string) {
  let id: string | null = null;
  useProjectStore.getState().update((d) => {
    id = make(d);
  });
  const ui = useEditorUiStore.getState();
  if (id) {
    ui.selectCues([id]);
    ui.setInspectorTab("cue");
  } else {
    announce(noRoom);
  }
}

/**
 * 右键菜单的“插入模板 ▸”：收藏 + 各分组，每组一个子菜单，点一个模板就插到右键的位置。
 */
export function InsertTemplatesSub({ trackId, timeMs, disabled }: InsertAt) {
  const { t, i18n } = useTranslation();
  const user = useCueTemplateStore((s) => s.user);
  const status = useCueTemplateStore((s) => s.status);
  const load = useCueTemplateStore((s) => s.load);
  const favoriteIds = useEditorPrefsStore((s) => s.favoriteTemplates);
  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);
  const templates = useMemo(() => allTemplates({ user }), [user]);
  const groups = useMemo(() => groupTemplates(templates), [templates]);
  const favorites = useMemo(
    () => favoriteIds.map((id) => templates.find((x) => x.id === id)).filter((x): x is CueTemplate => x !== undefined),
    [favoriteIds, templates],
  );
  const groupLabel = (g: string) => ((BUILTIN_GROUPS as readonly string[]).includes(g) ? t(`editor.templates.groups.${g}`) : g);

  const item = (tpl: CueTemplate) => (
    <ContextMenuItem
      key={tpl.id}
      onSelect={() => {
        if (!trackId) return;
        const label = templateName(tpl, i18n.language);
        insertAndSelect((d) => addTemplateCue(d, trackId, timeMs, tpl, label), t("editor.templates.noRoom"));
      }}
    >
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-sm border border-border bg-(--sw)"
        style={{ "--sw": cssColor(templateRgb(tpl)) } as CSSProperties}
      />
      <span className="truncate">{templateName(tpl, i18n.language)}</span>
    </ContextMenuItem>
  );

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled}>{t("editor.context.insertTemplate")}</ContextMenuSubTrigger>
      <ContextMenuSubContent aria-label={t("editor.context.insertTemplate")}>
        {templates.length === 0 && <ContextMenuItem disabled>{t("common.loading")}</ContextMenuItem>}
        {favorites.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Star aria-hidden className="size-3.5 fill-current text-warning" />
              {t("editor.templates.favorites")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className={SCROLL_CONTENT}>{favorites.map(item)}</ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {groups.map((g) => (
          <ContextMenuSub key={g.group}>
            <ContextMenuSubTrigger>{groupLabel(g.group)}</ContextMenuSubTrigger>
            <ContextMenuSubContent className={SCROLL_CONTENT}>{g.templates.map(item)}</ContextMenuSubContent>
          </ContextMenuSub>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * 右键菜单的“插入特效 ▸”：按分组列出特效，用上次在素材库里调过的参数（没有时为默认）插到右键的位置。
 */
export function InsertEffectsSub({ trackId, timeMs, disabled }: InsertAt) {
  const { t, i18n } = useTranslation();
  const user = useEffectLibraryStore((s) => s.user);
  const status = useEffectLibraryStore((s) => s.status);
  const load = useEffectLibraryStore((s) => s.load);
  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);
  const groups = useMemo(() => groupEffects(allEffects({ user })), [user]);

  const insert = (def: EffectDef) => {
    if (!trackId) return;
    const stored = useEditorPrefsStore.getState().effectParams[def.id];
    const params = stored ? sanitizeEffectParams(def, stored) : defaultEffectParams(def);
    const label = effectName(def, i18n.language);
    insertAndSelect((d) => addEffectDefCue(d, trackId, timeMs, def, params, label), t("editor.templates.noRoom"));
  };

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled}>{t("editor.context.insertEffect")}</ContextMenuSubTrigger>
      <ContextMenuSubContent aria-label={t("editor.context.insertEffect")}>
        {groups.map((g) => (
          <ContextMenuSub key={g.group}>
            <ContextMenuSubTrigger>{t(`editor.effectLib.groups.${g.group}`, { defaultValue: g.group })}</ContextMenuSubTrigger>
            <ContextMenuSubContent className={SCROLL_CONTENT}>
              {g.effects.map((def) => {
                const Icon = EFFECT_ICONS[def.icon ?? ""];
                return (
                  <ContextMenuItem key={def.id} onSelect={() => insert(def)}>
                    {Icon ? <Icon aria-hidden className="size-3.5" /> : <span aria-hidden className="size-3.5" />}
                    <span className="truncate">{effectName(def, i18n.language)}</span>
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
