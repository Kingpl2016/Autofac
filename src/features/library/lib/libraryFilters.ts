import type { LibraryEntry } from "@/features/recording";

/** 可排序的列。 */
export type LibrarySortKey = "name" | "duration" | "universes" | "size" | "modified";
/** 排序方向。 */
export type SortDir = "asc" | "desc";
/** 排序状态。 */
export interface LibrarySort {
  key: LibrarySortKey;
  dir: SortDir;
}
/** 类别筛选：全部 / 录制得到 / 编辑器节目 / 有问题（损坏、已恢复、文件头告警）。 */
export type KindFilter = "all" | "recorded" | "editor" | "issues";

/** 默认排序：最近修改的在前（与后端列举顺序一致）。 */
export const DEFAULT_SORT: LibrarySort = { key: "modified", dir: "desc" };
export const SORT_KEYS: readonly LibrarySortKey[] = ["name", "duration", "universes", "size", "modified"];
export const KIND_FILTERS: readonly KindFilter[] = ["all", "recorded", "editor", "issues"];

/**
 * 节目是否“有问题”：文件损坏（不含只有工程、还没导出的编辑器节目）、由崩溃恢复生成，或文件头带告警。
 *
 * @param e 节目。
 */
export function hasIssues(e: LibraryEntry): boolean {
  const broken = !e.valid && e.exported !== false;
  const warned = e.valid && Boolean(e.header?.diffFrames || (e.header?.issues.length ?? 0) > 0);
  return broken || e.recovered || warned;
}

/**
 * 节目是否属于某个类别。
 *
 * @param e 节目。
 * @param kind 类别。
 */
export function matchesKind(e: LibraryEntry, kind: KindFilter): boolean {
  switch (kind) {
    case "all":
      return true;
    case "recorded":
      return !e.editable;
    case "editor":
      return e.editable;
    case "issues":
      return hasIssues(e);
  }
}

/**
 * 节目是否匹配搜索词（名称 / 文件名 / 备注 / 来源，不区分大小写）。
 *
 * @param e 节目。
 * @param query 搜索词；空白视为不过滤。
 */
export function matchesQuery(e: LibraryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [e.name, e.fileName, e.notes, ...e.sources].join("\n").toLowerCase().includes(q);
}

/**
 * 按类别与搜索词过滤。
 *
 * @param entries 节目列表。
 * @param filter 过滤条件。
 */
export function filterEntries(
  entries: readonly LibraryEntry[],
  filter: { query: string; kind: KindFilter },
): LibraryEntry[] {
  return entries.filter((e) => matchesKind(e, filter.kind) && matchesQuery(e, filter.query));
}

/** 各类别的数量（筛选标签上的角标）。 */
export function countByKind(entries: readonly LibraryEntry[]): Record<KindFilter, number> {
  const out: Record<KindFilter, number> = { all: entries.length, recorded: 0, editor: 0, issues: 0 };
  for (const e of entries) {
    if (e.editable) out.editor += 1;
    else out.recorded += 1;
    if (hasIssues(e)) out.issues += 1;
  }
  return out;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 升序比较两个节目的某一列。 */
function compareAsc(a: LibraryEntry, b: LibraryEntry, key: LibrarySortKey): number {
  switch (key) {
    case "name":
      return collator.compare(a.name, b.name);
    case "duration":
      return a.durationUs - b.durationUs;
    case "universes":
      return a.universes.length - b.universes.length;
    case "size":
      return a.bytes - b.bytes;
    case "modified":
      return a.modifiedUnixMs - b.modifiedUnixMs;
  }
}

/**
 * 排序（返回新数组）。主键相同时按名称、再按路径，保证顺序稳定。
 *
 * @param entries 节目列表。
 * @param sort 排序状态。
 */
export function sortEntries(entries: readonly LibraryEntry[], sort: LibrarySort): LibraryEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort(
    (a, b) =>
      sign * compareAsc(a, b, sort.key) ||
      collator.compare(a.name, b.name) ||
      a.path.localeCompare(b.path),
  );
}

/**
 * 点击表头后的排序：同一列切换方向；换列时名称默认升序，数值列默认降序（大的在前）。
 *
 * @param current 当前排序。
 * @param key 被点击的列。
 */
export function nextSort(current: LibrarySort, key: LibrarySortKey): LibrarySort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

/** 节目库页面的 URL 状态。 */
export interface LibraryUrlState {
  /** 搜索词 */
  q: string;
  kind: KindFilter;
  sort: LibrarySort;
  /** 选中（详情面板展示）的节目路径；空串表示没有 */
  sel: string;
}

const isSortKey = (v: string | null): v is LibrarySortKey => SORT_KEYS.includes(v as LibrarySortKey);
const isKind = (v: string | null): v is KindFilter => KIND_FILTERS.includes(v as KindFilter);

/**
 * 从地址栏参数解析页面状态；非法取值回退默认值。
 *
 * @param params 地址栏参数。
 */
export function parseLibraryParams(params: URLSearchParams): LibraryUrlState {
  const key = params.get("sort");
  const dir = params.get("dir");
  const kind = params.get("kind");
  return {
    q: params.get("q") ?? "",
    kind: isKind(kind) ? kind : "all",
    sort: {
      key: isSortKey(key) ? key : DEFAULT_SORT.key,
      dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_SORT.dir,
    },
    sel: params.get("sel") ?? "",
  };
}

/**
 * 把页面状态的变更写回地址栏参数（返回新对象）；与默认值相同的参数不写，其余未知参数原样保留。
 *
 * @param params 当前参数。
 * @param patch 要修改的字段。
 */
export function writeLibraryParams(params: URLSearchParams, patch: Partial<LibraryUrlState>): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (name: string, value: string, fallback: string) => {
    if (value === fallback) next.delete(name);
    else next.set(name, value);
  };
  if (patch.q !== undefined) set("q", patch.q, "");
  if (patch.kind !== undefined) set("kind", patch.kind, "all");
  if (patch.sort !== undefined) {
    set("sort", patch.sort.key, DEFAULT_SORT.key);
    set("dir", patch.sort.dir, DEFAULT_SORT.dir);
  }
  if (patch.sel !== undefined) set("sel", patch.sel, "");
  return next;
}
