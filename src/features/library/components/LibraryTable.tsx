import { useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { LibraryEntry, ProgramActions } from "@/features/recording";
import type { LibrarySort, LibrarySortKey } from "../lib/libraryFilters";
import { LibraryTableRow } from "./LibraryTableRow";

/** 供父组件命令式聚焦某一行（关闭详情、结束改名后把焦点还给原行）。 */
export interface LibraryTableHandle {
  focusRow: (path: string) => void;
}

interface Column {
  /** 对应的排序键；不可排序的列为 `null` */
  sortKey: LibrarySortKey | null;
  labelKey: string;
  className?: string;
  /** 数值列右对齐 */
  numeric?: boolean;
  /** 表头文字仅供读屏 */
  srOnly?: boolean;
  /** 窄布局下隐藏 */
  wideOnly?: boolean;
}

const COLUMNS: Column[] = [
  { sortKey: null, labelKey: "library.colNo", className: "w-12", numeric: true },
  { sortKey: null, labelKey: "library.colPreview", className: "w-20", srOnly: true },
  // 名称列不设宽度：固定布局下吃掉其余空间
  { sortKey: "name", labelKey: "library.colName" },
  { sortKey: "duration", labelKey: "library.colDuration", className: "w-28", numeric: true },
  { sortKey: "universes", labelKey: "library.colUniverses", className: "w-28", numeric: true, wideOnly: true },
  { sortKey: "size", labelKey: "library.colSize", className: "w-28", numeric: true, wideOnly: true },
  { sortKey: "modified", labelKey: "library.colModified", className: "w-36" },
  { sortKey: null, labelKey: "library.colActions", className: "w-24", srOnly: true },
];

interface LibraryTableProps {
  /** 已过滤并排序的节目 */
  entries: readonly LibraryEntry[];
  /** 节目在整个库里的序号 */
  numbers: ReadonlyMap<string, number>;
  sort: LibrarySort;
  onSort: (key: LibrarySortKey) => void;
  selectedPath: string;
  /** 打开 / 关闭某个节目的详情（再次选择同一行时关闭） */
  onSelect: (path: string) => void;
  /** 清除选中（Esc） */
  onClearSelection: () => void;
  checked: ReadonlySet<string>;
  onCheck: (path: string, checked: boolean) => void;
  /** 勾选 / 取消勾选当前列出的全部节目 */
  onCheckAll: (checked: boolean) => void;
  actions: ProgramActions;
  freshPaths: ReadonlySet<string>;
  compact: boolean;
  nowMs: number;
  onRequestDelete: (entry: LibraryEntry) => void;
  onDuplicated: (path: string) => void;
  /** 改名成功（路径随之改变） */
  onRenamed: (from: string, to: string) => void;
  ref?: Ref<LibraryTableHandle>;
}

/**
 * 节目库表格：固定表头、可排序列（`aria-sort`）、勾选列（表头可全选 / 半选）、
 * 漫游焦点（↑/↓/Home/End 在行间移动），Ctrl+A 全选、Esc 先清除勾选再关闭详情。
 */
export function LibraryTable({
  entries,
  numbers,
  sort,
  onSort,
  selectedPath,
  onSelect,
  onClearSelection,
  checked,
  onCheck,
  onCheckAll,
  actions,
  freshPaths,
  compact,
  nowMs,
  onRequestDelete,
  onDuplicated,
  onRenamed,
  ref,
}: LibraryTableProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const has = (p: string | null) => p != null && entries.some((e) => e.path === p);
  const activePath = has(focusedPath) ? focusedPath : has(selectedPath) ? selectedPath : entries[0]?.path;

  const rows = () =>
    Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-path]") ?? []);
  const focusRow = (path: string) => rows().find((r) => r.dataset.path === path)?.focus();

  useImperativeHandle(ref, () => ({ focusRow }));

  const finishRename = (path: string) => {
    setRenamingPath(null);
    requestAnimationFrame(() => focusRow(path));
  };
  const commitRename = (entry: LibraryEntry, name: string) => {
    finishRename(entry.path);
    void actions.rename(entry, name).then((path) => {
      if (path) onRenamed(entry.path, path);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (renamingPath) return;
    if (e.key === "Escape") {
      if (checked.size > 0) onCheckAll(false);
      else if (selectedPath) onClearSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onCheckAll(true);
      return;
    }
    const list = rows();
    const idx = list.findIndex((r) => r === document.activeElement);
    if (idx < 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(idx + 1, list.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(idx - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  };

  const visibleChecked = entries.filter((e) => checked.has(e.path)).length;
  const allState =
    visibleChecked === 0 ? false : visibleChecked === entries.length ? true : ("indeterminate" as const);
  const columns = COLUMNS.filter((c) => !(compact && c.wideOnly));

  return (
    <table aria-label={t("library.tableLabel")} className="w-full min-w-[40rem] table-fixed text-sm">
      <thead>
        <tr>
          <th scope="col" className="sticky top-0 z-10 h-10 w-11 border-b border-border bg-card px-3">
            <Checkbox
              checked={allState}
              onCheckedChange={(v) => onCheckAll(v === true)}
              aria-label={t("library.selectAll")}
            />
          </th>
          {columns.map((c) => {
            const sorted = c.sortKey != null && sort.key === c.sortKey;
            const label = t(c.labelKey);
            return (
              <th
                key={c.labelKey}
                scope="col"
                aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                className={cn(
                  "sticky top-0 z-10 h-10 whitespace-nowrap border-b border-border bg-card px-3 text-xs font-medium text-muted-foreground",
                  c.numeric ? "text-right" : "text-left",
                  c.className,
                )}
              >
                {c.sortKey ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.sortKey as LibrarySortKey)}
                    aria-label={t("library.sortBy", { col: label })}
                    className={cn(
                      "-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-accent-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      c.numeric && "flex-row-reverse",
                      sorted && "text-foreground",
                    )}
                  >
                    {label}
                    {sorted ? (
                      sort.dir === "asc" ? (
                        <ArrowUp className="size-3.5" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3.5" aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                    )}
                  </button>
                ) : c.srOnly ? (
                  <span className="sr-only">{label}</span>
                ) : (
                  label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody ref={bodyRef} onKeyDown={handleKeyDown}>
        {entries.map((e) => (
          <LibraryTableRow
            key={e.path}
            entry={e}
            no={numbers.get(e.path) ?? 0}
            actions={actions}
            selected={e.path === selectedPath}
            checked={checked.has(e.path)}
            active={e.path === activePath}
            compact={compact}
            fresh={freshPaths.has(e.path.replaceAll("\\", "/"))}
            renaming={e.path === renamingPath}
            nowMs={nowMs}
            onSelect={onSelect}
            onCheck={onCheck}
            onActivate={setFocusedPath}
            onStartRename={setRenamingPath}
            onCommitRename={commitRename}
            onCancelRename={finishRename}
            onRequestDelete={onRequestDelete}
            onDuplicated={onDuplicated}
          />
        ))}
      </tbody>
    </table>
  );
}
