import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileClock, Library, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { folderOf, relativeTime } from "../lib/relativeTime";
import { useRecentFilesStore, type RecentFile } from "../stores/useRecentFilesStore";

interface RecentFilesListProps {
  /** 最多显示几项 */
  limit?: number;
  /** 打开一项 */
  onOpen: (item: RecentFile) => void;
  /** 显示“清空列表”与每项的移除按钮（文件菜单里显示，预览区不显示） */
  manage?: boolean;
  className?: string;
}

/**
 * 最近文件列表：名称、位置（节目库或所在文件夹）与相对时间；点击打开。
 * 列表为空时不渲染。
 */
export function RecentFilesList({ limit, onOpen, manage = false, className }: RecentFilesListProps) {
  const { t, i18n } = useTranslation();
  const items = useRecentFilesStore((s) => s.items);
  const remove = useRecentFilesStore((s) => s.remove);
  const clear = useRecentFilesStore((s) => s.clear);
  const titleId = useId();
  // 列表挂载时取一次“现在”：相对时间以打开列表的时刻为准
  const [now] = useState(() => Date.now());
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return null;

  return (
    <div className={cn("grid gap-0.5", className)}>
      <div className="flex items-center justify-between px-2 pt-1">
        <span id={titleId} className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {t("editor.recent.title")}
        </span>
        {manage && (
          <button
            type="button"
            onClick={clear}
            className="rounded-sm px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("editor.recent.clear")}
          </button>
        )}
      </div>
      <ul aria-labelledby={titleId} className="grid gap-0.5">
        {shown.map((item) => {
          const where = item.kind === "library" ? t("editor.recent.library") : folderOf(item.path) || item.path;
          return (
            <li key={item.path} className="group flex items-center rounded-sm hover:bg-accent">
              <button
                type="button"
                onClick={() => onOpen(item)}
                title={item.path}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.kind === "library" ? (
                  <Library aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileClock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {where} · {relativeTime(item.openedAt, now, i18n.language)}
                  </span>
                </span>
              </button>
              {manage && (
                <button
                  type="button"
                  aria-label={t("editor.recent.removeOne", { name: item.name })}
                  title={t("editor.recent.removeOne", { name: item.name })}
                  onClick={() => remove(item.path)}
                  className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
