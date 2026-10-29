import { useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useContextActions } from "../hooks/useContextActions";
import { formatChord } from "@/shared/lib/keyboard";
import { effectiveKeys, type Command } from "../lib/commands";
import { buildContextMenu, type MenuEntry } from "../lib/contextMenus";
import { CUE_TAG_COLORS, CUE_TAGS } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useKeymapStore } from "../stores/useKeymapStore";
import { useProjectStore } from "../stores/useProjectStore";
import { resolveContextTarget } from "../timeline/contextTarget";
import { readTimelineViewport } from "../timeline/timelineView";

/**
 * 时间线的右键菜单：包住整个时间线面板，右键时按点击位置（片段、媒体片段、轨道头、媒体轨道、空白处、标尺）
 * 生成菜单内容。点在没选中的片段 / 轨道上时先选中它；菜单项来自命令表（快捷键提示、可用状态一致）
 * 或位置相关的动作。键盘可用 Shift+F10 / 菜单键在选中的片段上打开。
 *
 * @param props.commands 全部命令。
 * @param props.children 时间线内容。
 */
export function TimelineContextMenu({ commands, children }: { commands: readonly Command[]; children: ReactNode }) {
  const { t } = useTranslation();
  const target = useEditorUiStore((s) => s.contextTarget);
  const setTarget = useEditorUiStore((s) => s.setContextTarget);
  const project = useProjectStore((s) => s.project);
  const selectedTrackIds = useEditorUiStore((s) => s.selectedTrackIds);
  const hasClipboard = useEditorUiStore((s) => s.clipboard.length > 0);
  const overrides = useKeymapStore((s) => s.overrides);
  const run = useContextActions();
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands]);
  const entries = target ? buildContextMenu(target, project, { selectedTrackIds, hasClipboard }) : [];

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const ui = useEditorUiStore.getState();
    const next = resolveContextTarget(
      e.target as Element,
      e.clientX,
      e.clientY,
      readTimelineViewport(),
      useProjectStore.getState().project.tracks.map((tr) => tr.id),
    );
    if (!next) {
      // 不在可操作区域：不打开菜单（阻止默认行为后 Radix 也不会打开）
      e.preventDefault();
      return;
    }
    // 先选中右键的对象（还没选中时）
    if (next.kind === "cue" && !ui.selectedCueIds.includes(next.id)) {
      ui.selectCues([next.id]);
      const trackId = useProjectStore.getState().project.cues.find((c) => c.id === next.id)?.trackId;
      if (trackId) ui.selectTrack(trackId);
    }
    if (next.kind === "mediaClip" && !ui.selectedMediaClipIds.includes(next.id)) ui.selectMediaClips([next.id]);
    if (next.kind === "track" && !ui.selectedTrackIds.includes(next.id)) ui.selectTrack(next.id);
    if (next.kind === "empty" && next.trackId) ui.selectTrack(next.trackId);
    if (next.kind === "marker" || next.kind === "section") ui.selectTimelineObject({ kind: next.kind, id: next.id });
    if (next.kind === "keyframe" && !ui.selectedCueIds.includes(next.cueId)) ui.selectCues([next.cueId]);
    setTarget(next);
  };

  /** 去掉开头、结尾与连续的分隔线（命令不存在时可能留下）。 */
  const visible = (list: MenuEntry[]) =>
    list
      .filter((e) => e.kind !== "command" || byId.has(e.id))
      .filter((e, i, all) => e.kind !== "separator" || (i > 0 && i < all.length - 1 && all[i - 1].kind !== "separator"));

  const renderEntry = (entry: MenuEntry, i: number) => {
    switch (entry.kind) {
      case "separator":
        return <ContextMenuSeparator key={`sep-${i}`} />;
      case "command": {
        const command = byId.get(entry.id);
        if (!command) return null;
        const keys = effectiveKeys(command, overrides);
        const destructive = command.id === "edit.delete" || command.id === "edit.rippleDelete";
        return (
          <ContextMenuItem
            key={command.id}
            variant={destructive ? "destructive" : "default"}
            disabled={command.enabled ? !command.enabled() : false}
            onSelect={() => command.run()}
          >
            {t(command.titleKey)}
            {keys[0] && <ContextMenuShortcut>{formatChord(keys[0])}</ContextMenuShortcut>}
          </ContextMenuItem>
        );
      }
      case "action": {
        const label = t(entry.labelKey, entry.labelArgs);
        if (entry.checked !== undefined) {
          return (
            <ContextMenuCheckboxItem
              key={entry.id}
              checked={entry.checked}
              disabled={entry.disabled}
              onSelect={() => target && run.run(entry.id, target)}
            >
              {label}
            </ContextMenuCheckboxItem>
          );
        }
        return (
          <ContextMenuItem
            key={entry.id}
            variant={entry.destructive ? "destructive" : "default"}
            disabled={entry.disabled}
            onSelect={() => target && run.run(entry.id, target)}
          >
            {label}
          </ContextMenuItem>
        );
      }
      case "tags":
        return (
          <ContextMenuSub key="tags">
            <ContextMenuSubTrigger>{t("editor.context.tag")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {CUE_TAGS.map((tag) => {
                const [r, g, b] = CUE_TAG_COLORS[tag];
                return (
                  <ContextMenuItem key={tag} onSelect={() => run.tag(tag)}>
                    <span
                      aria-hidden
                      className="size-3 rounded-full bg-(--tag-color)"
                      style={{ "--tag-color": `rgb(${r} ${g} ${b})` } as CSSProperties}
                    />
                    {t(`editor.tags.${tag}`)}
                  </ContextMenuItem>
                );
              })}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => run.tag(null)}>{t("editor.context.clearTag")}</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
      case "sectionColors":
        return (
          <ContextMenuSub key="sectionColors">
            <ContextMenuSubTrigger>{t("editor.context.sectionColor")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {CUE_TAGS.map((tag) => {
                const [r, g, b] = CUE_TAG_COLORS[tag];
                return (
                  <ContextMenuItem
                    key={tag}
                    onSelect={() => target?.kind === "section" && run.sectionColor(target.id, CUE_TAG_COLORS[tag])}
                  >
                    <span
                      aria-hidden
                      className="size-3 rounded-full bg-(--tag-color)"
                      style={{ "--tag-color": `rgb(${r} ${g} ${b})` } as CSSProperties}
                    />
                    {t(`editor.tags.${tag}`)}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        );
    }
  };

  return (
    <ContextMenu onOpenChange={(open) => !open && setTarget(null)}>
      <ContextMenuTrigger asChild>
        <div className="contents" onContextMenu={onContextMenu}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("editor.context.title")}>{visible(entries).map(renderEntry)}</ContextMenuContent>
    </ContextMenu>
  );
}
