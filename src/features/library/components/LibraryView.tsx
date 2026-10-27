import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, FolderOpen, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatBytes,
  messageOf,
  ProgramDeleteDialog,
  RECORDINGS_QUERY_KEY,
  recordingsList,
  useProgramActions,
  useRecordingStore,
  type LibraryEntry,
} from "@/features/recording";
import { recordingOpenDir } from "@/features/settings";
import { PageHeader } from "@/shared/components/PageHeader";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { useNow } from "@/shared/hooks/useNow";
import { useLibraryUrlState } from "../hooks/useLibraryUrlState";
import { countByKind, filterEntries, nextSort, sortEntries, type LibrarySortKey } from "../lib/libraryFilters";
import { BulkActionBar } from "./BulkActionBar";
import { BulkDeleteDialog } from "./BulkDeleteDialog";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { LibraryTable, type LibraryTableHandle } from "./LibraryTable";
import { LibraryToolbar } from "./LibraryToolbar";
import { ProgramDetailPanel } from "./ProgramDetailPanel";

/** 详情面板与表格并排所需的最小窗口宽度（Tailwind `xl`）；更窄时详情放进抽屉。 */
const WIDE_QUERY = "(min-width: 80rem)";
/** 表格显示全部列所需的最小窗口宽度（`2xl`）；详情并排时也收起次要列。 */
const ROOMY_QUERY = "(min-width: 96rem)";
/** 加载中占位的行数。 */
const SKELETON_ROWS = 8;

/** 判断键盘事件是否发生在可输入元素里（此时不触发页面快捷键）。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * 节目库页面：页头（打开录制目录 / 刷新 / 新建编辑器节目）+ 搜索与类别筛选 + 可排序表格，
 * 选中节目后右侧并排显示详情（窄屏放进抽屉）；勾选多行后底部出现批量操作条。
 *
 * 搜索、类别、排序与选中的节目保存在地址栏里（可刷新、可从录制页跳转定位）；勾选只在本页有效。
 */
export function LibraryView() {
  const { t } = useTranslation();
  // 节目库页面本身处于播放器模式：点“回放此节目”直接在本页播放，不跳转到播放器页
  const actions = useProgramActions(undefined, { stayOnPage: true });
  const wide = useMediaQuery(WIDE_QUERY);
  const roomy = useMediaQuery(ROOMY_QUERY);
  const nowMs = useNow(30_000);
  const lastResult = useRecordingStore((s) => s.last);
  const [url, update] = useLibraryUrlState();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [toDelete, setToDelete] = useState<LibraryEntry | null>(null);
  const [bulkDelete, setBulkDelete] = useState<readonly LibraryEntry[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const tableRef = useRef<LibraryTableHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const list = useQuery({ queryKey: RECORDINGS_QUERY_KEY, queryFn: recordingsList });
  const entries = useMemo(() => list.data ?? [], [list.data]);
  const { refresh } = actions;

  // 一次录制结束后自动刷新列表
  useEffect(() => {
    if (lastResult) refresh();
  }, [lastResult, refresh]);

  // `/` 聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const numbers = useMemo(() => new Map(entries.map((e, i) => [e.path, i + 1])), [entries]);
  const counts = useMemo(() => countByKind(entries), [entries]);
  const visible = useMemo(
    () => sortEntries(filterEntries(entries, { query: url.q, kind: url.kind }), url.sort),
    [entries, url.q, url.kind, url.sort],
  );
  const freshPaths = useMemo(
    () => new Set(lastResult?.files.map((f) => f.path.replaceAll("\\", "/")) ?? []),
    [lastResult],
  );
  const selected = useMemo(() => entries.find((e) => e.path === url.sel) ?? null, [entries, url.sel]);
  // 只对当前列出的节目做批量操作：筛选掉的勾选项不参与
  const checkedEntries = useMemo(() => visible.filter((e) => checked.has(e.path)), [visible, checked]);
  const totalBytes = useMemo(() => entries.reduce((n, e) => n + e.bytes, 0), [entries]);
  const filtering = url.q.trim() !== "" || url.kind !== "all";

  const select = useCallback((path: string) => update({ sel: path }), [update]);
  const toggleSelect = useCallback(
    (path: string) => update({ sel: path === url.sel ? "" : path }),
    [update, url.sel],
  );
  const closeDetail = useCallback(() => {
    const path = url.sel;
    update({ sel: "" });
    if (path) requestAnimationFrame(() => tableRef.current?.focusRow(path));
  }, [update, url.sel]);

  const handleCheck = useCallback((path: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  const handleCheckAll = useCallback(
    (on: boolean) => setChecked(on ? new Set(visible.map((e) => e.path)) : new Set()),
    [visible],
  );
  const handleRenamed = useCallback(
    (from: string, to: string) => {
      if (from === url.sel) select(to);
      setChecked((prev) => {
        if (!prev.has(from)) return prev;
        const next = new Set(prev);
        next.delete(from);
        next.add(to);
        return next;
      });
    },
    [select, url.sel],
  );
  const handleDeleted = useCallback(
    (paths: readonly string[]) => {
      if (paths.includes(url.sel)) update({ sel: "" });
      setChecked((prev) => new Set([...prev].filter((p) => !paths.includes(p))));
    },
    [update, url.sel],
  );

  const clearFilters = () => update({ q: "", kind: "all" });
  const handleSort = (key: LibrarySortKey) => update({ sort: nextSort(url.sort, key) });

  const openDir = () => void recordingOpenDir().catch((e: unknown) => toast.error(messageOf(e)));

  const uploadChecked = async () => {
    setBulkUploading(true);
    try {
      // 依次加入全局传输队列（每个都有自己的进度与结果提示）
      for (const e of checkedEntries.filter((x) => x.valid)) await actions.upload(e);
    } finally {
      setBulkUploading(false);
    }
  };

  const detail = selected && (
    <ProgramDetailPanel
      key={selected.path}
      entry={selected}
      actions={actions}
      embedded={!wide}
      onRenamed={handleRenamed}
      onDuplicated={select}
      onRequestDelete={setToDelete}
      onClose={closeDetail}
    />
  );

  return (
    <div className="flex h-full min-h-[28rem] flex-col gap-4">
      <PageHeader
        className="mb-0"
        title={t("library.title")}
        subtitle={t("library.subtitle", { n: entries.length, size: formatBytes(totalBytes) })}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openDir}>
              <FolderOpen />
              {t("library.openDir")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-10"
              aria-label={t("library.refresh")}
              title={t("library.refresh")}
              onClick={refresh}
            >
              <RefreshCw className={list.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />
            </Button>
            <Button asChild size="sm">
              <Link to="/editor">
                <Clapperboard />
                {t("library.newShow")}
              </Link>
            </Button>
          </>
        }
      />

      <LibraryToolbar
        query={url.q}
        onQueryChange={(q) => update({ q })}
        searchRef={searchRef}
        kind={url.kind}
        onKindChange={(kind) => update({ kind })}
        counts={counts}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <section
          data-surface=""
          aria-busy={list.isLoading}
          className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <div className="min-h-0 flex-1 overflow-auto">
            {list.isLoading ? (
              <div className="grid gap-2 p-4" aria-label={t("common.loading")}>
                {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : list.isError ? (
              <LibraryEmptyState
                kind="error"
                reason={messageOf(list.error)}
                onClearFilters={clearFilters}
                onRetry={refresh}
              />
            ) : entries.length === 0 ? (
              <LibraryEmptyState kind="none" onClearFilters={clearFilters} onRetry={refresh} />
            ) : visible.length === 0 ? (
              <LibraryEmptyState kind="filtered" onClearFilters={clearFilters} onRetry={refresh} />
            ) : (
              <LibraryTable
                ref={tableRef}
                entries={visible}
                numbers={numbers}
                sort={url.sort}
                onSort={handleSort}
                selectedPath={url.sel}
                onSelect={toggleSelect}
                onClearSelection={closeDetail}
                checked={checked}
                onCheck={handleCheck}
                onCheckAll={handleCheckAll}
                actions={actions}
                freshPaths={freshPaths}
                compact={!roomy}
                nowMs={nowMs}
                onRequestDelete={setToDelete}
                onDuplicated={select}
                onRenamed={handleRenamed}
              />
            )}
          </div>

          {checkedEntries.length > 0 ? (
            <BulkActionBar
              entries={checkedEntries}
              canUpload={actions.canUpload}
              uploading={bulkUploading}
              onUpload={() => void uploadChecked()}
              onDelete={() => setBulkDelete(checkedEntries)}
              onClear={() => setChecked(new Set())}
            />
          ) : (
            <footer className="flex min-h-10 items-center justify-between gap-4 border-t border-border px-4 text-xs text-muted-foreground">
              <span>{t("library.footerHint")}</span>
              {filtering && entries.length > 0 && (
                <span className="flex items-center gap-2">
                  <span className="num">{t("library.filtered", { shown: visible.length, total: entries.length })}</span>
                  <Button variant="link" className="h-auto p-0 text-xs" onClick={clearFilters}>
                    {t("library.clearFilters")}
                  </Button>
                </span>
              )}
            </footer>
          )}
        </section>

        {wide && detail}
      </div>

      {!wide && (
        <Sheet open={selected !== null} onOpenChange={(open) => !open && closeDetail()}>
          <SheetContent className="max-w-md bg-surface-1">
            <SheetHeader className="sr-only">
              <SheetTitle>{t("library.detailTitle")}</SheetTitle>
              <SheetDescription>{selected?.name}</SheetDescription>
            </SheetHeader>
            {detail}
          </SheetContent>
        </Sheet>
      )}

      <ProgramDeleteDialog
        entry={toDelete}
        onCancel={() => setToDelete(null)}
        onConfirm={(entry) =>
          void actions.remove(entry).then((ok) => {
            if (ok) handleDeleted([entry.path]);
          })
        }
      />
      <BulkDeleteDialog
        entries={bulkDelete}
        actions={actions}
        onClose={() => setBulkDelete([])}
        onDone={handleDeleted}
      />
    </div>
  );
}
