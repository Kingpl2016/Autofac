import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, FolderOpen, Library, Loader2, PackageOpen, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/shared/components/Segmented";
import { useTauriEvent } from "@/shared/events/useObservable";
import { pickDirectory, pickZipFile } from "@/shared/tauri/pickers";
import { oflCatalogKeys, oflCatalogOpen, oflCatalogSearch, oflCatalogSummary } from "../lib/api";
import { fixtureErrorText } from "../lib/errors";
import type { CatalogItem, CatalogQuery, CatalogStatus, CatalogSummary, ImportOutcome } from "../lib/types";
import { useFixtureStore } from "../stores/useFixtureStore";

interface OflCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入完成（对话框已关闭），由调用方展示导入结果。 */
  onImported: (outcome: ImportOutcome) => void;
}

/** 进度事件载荷。 */
interface Progress {
  done: number;
  total: number;
}

/** 每次从后端取的条数。 */
const PAGE = 500;
/** 一行的估计高度（像素）。 */
const ROW_HEIGHT = 56;
/** 没有尺寸信息时先渲染的行数。 */
const FIRST_SCREEN = 12;
/** “全部”选项的占位值（Radix Select 不允许空串）。 */
const ALL = "__all__";

/**
 * 一个目录项的模式摘要：`3 种模式 · 9–14 通道`。
 *
 * @param item 目录项。
 * @returns 摘要文字。
 */
function modesText(item: CatalogItem, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const channels = item.modes.map((m) => m.channels);
  if (channels.length === 0) return "";
  const lo = Math.min(...channels);
  const hi = Math.max(...channels);
  return t("fixtures.catalog.modes", { count: channels.length, channels: lo === hi ? `${lo}` : `${lo}–${hi}` });
}

/**
 * OFL 整库浏览对话框：打开官方 zip 或文件夹建立目录，按名称 / 制造商 / 分类 / 状态筛选，
 * 勾选后导入（只导入需要的型号，库保持精简）。列表虚拟滚动，后端分页查询。
 */
export function OflCatalogDialog({ open, onOpenChange, onImported }: OflCatalogDialogProps) {
  const { t } = useTranslation();
  const importCatalog = useFixtureStore((s) => s.importCatalog);
  const [summary, setSummary] = useState<CatalogSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [opening, setOpening] = useState<Progress | null>(null);
  const [importing, setImporting] = useState<Progress | null>(null);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [manufacturer, setManufacturer] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [status, setStatus] = useState<CatalogStatus | "all">("all");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const loadingPage = useRef(false);
  const generation = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useTauriEvent<Progress>("ofl:catalog-progress", (p) => setOpening((cur) => (cur ? p : cur)));
  useTauriEvent<Progress>("ofl:import-progress", (p) => setImporting((cur) => (cur ? p : cur)));

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(id);
  }, [text]);

  const query = useMemo<CatalogQuery>(
    () => ({
      text: debounced,
      manufacturer: manufacturer === ALL ? undefined : manufacturer,
      category: category === ALL ? undefined : category,
      status: status === "all" ? undefined : status,
      offset: 0,
      limit: PAGE,
    }),
    [debounced, manufacturer, category, status],
  );

  // 打开时读取上次的目录
  useEffect(() => {
    if (!open) return;
    setLoadingSummary(true);
    oflCatalogSummary()
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoadingSummary(false));
  }, [open]);

  const refresh = useCallback(async () => {
    if (!summary) return;
    const gen = ++generation.current;
    try {
      const page = await oflCatalogSearch(query);
      if (gen !== generation.current) return;
      setItems(page.items);
      setTotal(page.total);
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (e) {
      toast.error(fixtureErrorText(t, e));
    }
  }, [query, summary, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 虚拟列表返回的函数不能被 React Compiler 记忆化；本组件因此不做自动记忆化（列表行数有限，开销可忽略）
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // 测试环境与首次布局前没有尺寸：先按一屏渲染
    initialRect: { width: 640, height: 420 },
  });
  const virtualRows = virtualizer.getVirtualItems();
  // 滚动容器还没有尺寸（首次布局前、测试环境）时先渲染第一屏，避免列表空白
  const rows: readonly { index: number; start: number }[] =
    virtualRows.length > 0 || items.length === 0
      ? virtualRows
      : items.slice(0, FIRST_SCREEN).map((_, index) => ({ index, start: index * ROW_HEIGHT }));
  const lastIndex = rows.at(-1)?.index ?? 0;

  // 滚到已加载部分的末尾附近时取下一页
  useEffect(() => {
    if (items.length >= total || lastIndex < items.length - 40 || loadingPage.current) return;
    loadingPage.current = true;
    const gen = generation.current;
    oflCatalogSearch({ ...query, offset: items.length })
      .then((page) => {
        if (gen === generation.current) setItems((cur) => [...cur, ...page.items]);
      })
      .catch(() => undefined)
      .finally(() => {
        loadingPage.current = false;
      });
  }, [items.length, lastIndex, query, total]);

  const openBundle = async (kind: "zip" | "dir") => {
    const path = kind === "zip" ? await pickZipFile(t("fixtures.catalog.zipType")) : await pickDirectory();
    if (!path) return;
    setOpening({ done: 0, total: 0 });
    try {
      const s = await oflCatalogOpen(path);
      setSummary(s);
      setSelected(new Set());
      setManufacturer(ALL);
      setCategory(ALL);
      toast.success(t("fixtures.catalog.opened", { count: s.entries }));
    } catch (e) {
      toast.error(t("fixtures.catalog.openFailed", { reason: fixtureErrorText(t, e) }));
    } finally {
      setOpening(null);
    }
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const selectMatching = async (extra?: Partial<CatalogQuery>) => {
    try {
      const keys = await oflCatalogKeys({ ...query, ...extra });
      setSelected((cur) => new Set([...cur, ...keys]));
    } catch (e) {
      toast.error(fixtureErrorText(t, e));
    }
  };

  const runImport = async () => {
    if (selected.size === 0) return;
    setImporting({ done: 0, total: selected.size });
    try {
      const outcome = await importCatalog([...selected]);
      setSelected(new Set());
      onOpenChange(false);
      onImported(outcome);
    } catch (e) {
      toast.error(t("fixtures.import.failed", { reason: fixtureErrorText(t, e) }));
    } finally {
      setImporting(null);
    }
  };

  const busy = opening !== null || importing !== null;
  const progress = opening ?? importing;
  const statusLabel = (s: CatalogStatus) =>
    s === "imported" ? t("fixtures.catalog.status.imported") : s === "outdated" ? t("fixtures.catalog.status.outdated") : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="size-5" aria-hidden />
            {t("fixtures.catalog.title")}
          </DialogTitle>
          <DialogDescription>
            {summary
              ? t("fixtures.catalog.summary", {
                  entries: summary.entries,
                  manufacturers: summary.manufacturers.length,
                  source: summary.source,
                })
              : t("fixtures.catalog.intro")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void openBundle("zip")} disabled={busy}>
            <PackageOpen aria-hidden />
            {t("fixtures.catalog.openZip")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void openBundle("dir")} disabled={busy}>
            <FolderOpen aria-hidden />
            {t("fixtures.catalog.openDir")}
          </Button>
        </div>

        {progress && (
          <div role="status" className="grid gap-1 text-sm">
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {opening ? t("fixtures.catalog.scanning") : t("fixtures.catalog.importing")}
              {progress.total > 0 && <span className="num text-muted-foreground">{`${progress.done}/${progress.total}`}</span>}
            </span>
            <progress className="h-1.5 w-full" max={Math.max(1, progress.total)} value={progress.done} />
          </div>
        )}

        {!summary && !loadingSummary && !opening && (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("fixtures.catalog.empty")}
          </p>
        )}

        {summary && (
          <>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t("fixtures.catalog.search")}
                  aria-label={t("fixtures.catalog.search")}
                  className="h-9 pl-9"
                />
              </div>
              <Select value={manufacturer} onValueChange={setManufacturer}>
                <SelectTrigger className="h-9" aria-label={t("fixtures.catalog.manufacturer")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("fixtures.catalog.allManufacturers")}</SelectItem>
                  {summary.manufacturers.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {`${m.name} (${m.count})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-9" aria-label={t("fixtures.catalog.category")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("fixtures.catalog.allCategories")}</SelectItem>
                  {summary.categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented<CatalogStatus | "all">
                size="xs"
                ariaLabel={t("fixtures.catalog.statusFilter")}
                value={status}
                onChange={setStatus}
                options={[
                  { value: "all", label: t("fixtures.list.all") },
                  { value: "new", label: t("fixtures.catalog.status.new") },
                  { value: "outdated", label: t("fixtures.catalog.status.outdated") },
                  { value: "imported", label: t("fixtures.catalog.status.imported") },
                ]}
              />
              <span className="flex flex-wrap items-center gap-1">
                <span className="num mr-2 text-xs text-muted-foreground" aria-live="polite">
                  {t("fixtures.catalog.matches", { count: total })}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void selectMatching()} disabled={busy || total === 0}>
                  {t("fixtures.catalog.selectMatching")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void selectMatching({ status: "outdated", text: "", manufacturer: undefined, category: undefined })}
                  disabled={busy}
                >
                  {t("fixtures.catalog.selectOutdated")}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                  {t("fixtures.catalog.clearSelection")}
                </Button>
              </span>
            </div>

            <div
              ref={scrollRef}
              className="min-h-48 flex-1 overflow-y-auto rounded-md border border-border"
              style={{ height: "min(26rem, 50vh)" }}
            >
              {items.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">{t("fixtures.list.noMatch")}</p>
              ) : (
                <ul aria-label={t("fixtures.catalog.results")} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                  {rows.map((row) => {
                    const item = items[row.index];
                    const checkboxId = `ofl-${row.index}`;
                    const label = statusLabel(item.status);
                    return (
                      <li
                        key={item.key}
                        data-index={row.index}
                        ref={virtualizer.measureElement}
                        className="absolute top-0 left-0 flex w-full items-center gap-3 border-b border-border/60 px-3 py-2"
                        style={{ transform: `translateY(${row.start}px)` }}
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={selected.has(item.key)}
                          onCheckedChange={(v) => toggle(item.key, v === true)}
                          disabled={busy}
                        />
                        <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium">{item.name}</span>
                            {label && <Badge variant={item.status === "outdated" ? "default" : "secondary"}>{label}</Badge>}
                            {item.matrix && <Badge variant="outline">{t("fixtures.catalog.matrix")}</Badge>}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.manufacturer}
                            {item.categories.length > 0 && ` · ${item.categories.join(" / ")}`}
                            {item.modes.length > 0 && ` · ${modesText(item, t)}`}
                          </span>
                          {item.redirectTo && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <ArrowRight className="size-3" aria-hidden />
                              {t("fixtures.catalog.redirect", { target: item.redirectTo })}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="num text-sm text-muted-foreground">{t("fixtures.catalog.selected", { count: selected.size })}</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button type="button" onClick={() => void runImport()} disabled={busy || selected.size === 0}>
              {importing ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("fixtures.catalog.import", { count: selected.size })}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
