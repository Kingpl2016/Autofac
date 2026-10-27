import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, Boxes, Film, History, Lamp, LayoutTemplate, Sparkles, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LIBRARY_TABS, useEditorUiStore, type LibraryTab } from "../stores/useEditorUiStore";

/** 每个素材分区的图标。 */
const ICONS: Record<LibraryTab, LucideIcon> = {
  media: Film,
  fixtures: Lamp,
  cues: LayoutTemplate,
  effects: Sparkles,
  presets: Bookmark,
  groups: Boxes,
  history: History,
};

/** 素材库内容区的 id（图标栏的标签页指向它）。 */
export const LIBRARY_PANEL_ID = "editor-library-panel";

/**
 * 左侧图标栏（剪映式）：切换素材分区。竖向 tablist，↑ / ↓ / Home / End 移动并切换，
 * 当前分区高亮并带左侧强调条。
 */
export function IconRail() {
  const { t } = useTranslation();
  const tab = useEditorUiStore((s) => s.libraryTab);
  const setTab = useEditorUiStore((s) => s.setLibraryTab);
  const refs = useRef<Partial<Record<LibraryTab, HTMLButtonElement | null>>>({});

  const move = (to: LibraryTab) => {
    setTab(to);
    refs.current[to]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = LIBRARY_TABS.indexOf(tab);
    const n = LIBRARY_TABS.length;
    if (e.key === "ArrowDown") move(LIBRARY_TABS[(i + 1) % n]);
    else if (e.key === "ArrowUp") move(LIBRARY_TABS[(i - 1 + n) % n]);
    else if (e.key === "Home") move(LIBRARY_TABS[0]);
    else if (e.key === "End") move(LIBRARY_TABS[n - 1]);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={t("editor.library.title")}
      className="flex h-full w-14 shrink-0 flex-col items-stretch gap-1 border-r border-border bg-surface-1 py-2"
      onKeyDown={onKeyDown}
    >
      {LIBRARY_TABS.map((id) => {
        const Icon = ICONS[id];
        const selected = id === tab;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`editor-library-tab-${id}`}
            aria-selected={selected}
            aria-controls={LIBRARY_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTab(id)}
            className={cn(
              "relative mx-1 flex cursor-pointer flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] leading-tight",
              "text-muted-foreground transition-colors duration-150 hover:bg-surface-3 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected && "bg-surface-3 text-foreground",
            )}
          >
            {selected && <span aria-hidden className="absolute inset-y-1.5 -left-1 w-0.5 rounded-full bg-primary" />}
            <Icon className={cn("size-4", selected && "text-primary")} aria-hidden />
            <span className="max-w-full truncate px-0.5">{t(`editor.library.${id}`)}</span>
          </button>
        );
      })}
    </div>
  );
}
