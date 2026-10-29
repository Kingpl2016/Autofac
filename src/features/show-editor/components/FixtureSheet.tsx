import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns3, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ATTRIBUTE_GROUPS, groupOf, type AttributeGroup, type ChannelFunction } from "@/features/fixtures";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { cssColor } from "../lib/cueTemplates";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { baseOf } from "../lib/fixtureRef";
import {
  arrangeSheetRows,
  buildSheet,
  cellTarget,
  formatCell,
  manualEmitters,
  parseCell,
  SHEET_FILTERS,
  SHEET_READOUTS,
  SHEET_SORTS,
  sheetColumns,
  visibleColumns,
  type SheetCell,
  type SheetReadout,
  type SheetRow,
  type SheetSort,
} from "../lib/fixtureSheet";
import { knockout, programAttr, programColor, programIntensity } from "../lib/programmer";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { EmptyHint } from "./EmptyHint";
import { HelpTip } from "./HelpTip";

/** 正在编辑的单元格。 */
interface EditingCell {
  fixtureId: string;
  fn: ChannelFunction;
}

/** 单元格在表格里的位置键（键盘导航用）。 */
const cellKey = (row: number, col: number) => `${row}:${col}`;

/**
 * 灯具表（Fixture Sheet）：每台灯一行、每种功能一列，显示播放头时刻的实际输出。
 *
 * - 读数：百分比、两位小数的百分比、8 位 DMX、16 位 DMX、十六进制；编辑时按同一种读数输入；
 * - 搜索（名称、型号、地址，`@12` / `1.12` 按地址找）、只看选中 / 只看编程中的灯、按工程顺序 / 名称 / 地址排序、
 *   按属性组隐藏列、型号列；这些设置记在编辑器偏好里；
 * - 点行选灯（Ctrl 追加、Shift 连选），与编程器、预览区共用选择；别处改了选择时滚动到选中的行；
 *   悬停的行与舞台 / 色块互相高亮；
 * - 多头 / 像素灯可以展开出像素行（可一键展开 / 收起全部），像素行同样可以选中、编辑（写入像素引用 `灯具id#n`）；
 * - 编程器里有值的单元格高亮；
 * - 单元格：点击或 Enter 输入新值写入编程器，Delete 清除这一层的编程器值，方向键在单元格之间移动——
 *   这台灯在选择里时，同时作用于所有选中且有该功能的灯。
 */
export function FixtureSheet() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const hoverId = useEditorUiStore((s) => s.hoverFixtureId);
  const setHover = useEditorUiStore((s) => s.setHoverFixture);
  const values = useProgrammerStore((s) => s.values);
  const setValues = useProgrammerStore((s) => s.setValues);
  const prefs = useEditorPrefsStore((s) => s.sheet);
  const setPrefs = useEditorPrefsStore((s) => s.setSheetPrefs);
  const engine = useEngine();
  const evaluate = useMemo(() => createDmxEvaluator(preview, engine), [preview, engine]);
  const colorsAt = useMemo(() => createPreviewEvaluator(preview, engine), [preview, engine]);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [query, setQuery] = useState("");
  // 与“展开全部”偏好相反的灯（单独展开 / 收起过的）
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const pendingFocus = useRef<string | null>(null);

  const expanded = useMemo(() => {
    const out = new Set<string>();
    for (const f of project.fixtures) if (prefs.expandPixels !== toggled.has(f.id)) out.add(f.id);
    return out;
  }, [project.fixtures, prefs.expandPixels, toggled]);

  const frames = new Map<number, Uint8Array>();
  const frameOf = (u: number) => {
    let f = frames.get(u);
    if (!f) {
      f = evaluate(playheadMs, u);
      frames.set(u, f);
    }
    return f;
  };
  const allRows = buildSheet(project, frameOf, values, expanded);
  const selected = new Set(selectedIds);
  const selectedBase = new Set(selectedIds.map(baseOf));
  const programmedBase = new Set(Object.keys(values).map(baseOf));
  const rows = arrangeSheetRows(allRows, { query, filter: prefs.filter, sort: prefs.sort, selected: selectedBase, programmed: programmedBase });
  const presentColumns = sheetColumns(allRows);
  const columns = visibleColumns(presentColumns, new Set(prefs.hiddenGroups));
  const presentGroups = ATTRIBUTE_GROUPS.filter((g) => presentColumns.some((fn) => groupOf(fn) === g));
  const colors = colorsAt(playheadMs);
  const hasPixels = allRows.some((r) => r.pixels > 0);

  // 别处（舞台、色块、Patch）改了选择时，把第一台选中的灯滚动到可见处
  const firstSelected = selectedIds[0] ?? null;
  useEffect(() => {
    if (!firstSelected) return;
    const el = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${firstSelected.replace(/"/g, "")}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [firstSelected]);

  // 编辑结束后焦点回到原来的单元格
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key || editing) return;
    pendingFocus.current = null;
    tableRef.current?.querySelector<HTMLElement>(`[data-cell="${key}"]`)?.focus();
  });

  if (allRows.length === 0) return <EmptyHint>{t("editor.preview.empty")}</EmptyHint>;

  const toggleExpanded = (id: string) =>
    setToggled((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = (open: boolean) => {
    setPrefs({ expandPixels: open });
    setToggled(new Set());
  };

  const pickRow = (index: number, e: MouseEvent) => {
    const id = rows[index].fixtureId;
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelected(rows.slice(a, b + 1).map((r) => r.fixtureId));
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) setSelected(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    else setSelected([id]);
  };

  /** 作用对象：这台灯；它在选择里时为全部选中且有该功能的灯。 */
  const targetsOf = (fixtureId: string, fn: ChannelFunction) =>
    selected.has(fixtureId) ? allRows.filter((r) => selected.has(r.fixtureId) && r.cells.has(fn)).map((r) => r.fixtureId) : [fixtureId];

  /** 写入编程器（属性值 0~1）。 */
  const commit = (fixtureId: string, fn: ChannelFunction, fraction: number) => {
    const targets = targetsOf(fixtureId, fn);
    const target = cellTarget(fn);
    let next = values;
    if (target.kind === "intensity") next = programIntensity(next, targets, fraction * 100);
    else if (target.kind === "attr") next = programAttr(next, targets, target.key, fraction);
    else if (target.kind === "emitter") {
      for (const id of targets) {
        next = programColor(next, [id], { kind: "manual", values: { ...manualEmitters(next, id), [target.key]: fraction } });
        if (!next[id]?.intensity) next = programIntensity(next, [id], 100);
      }
    }
    setValues(next);
  };

  /** 清除这一层的编程器值（Delete）。 */
  const clearLayer = (fixtureId: string, cell: SheetCell) => {
    const target = cellTarget(cell.fn);
    if (target.kind === "readonly") return;
    const targets = targetsOf(fixtureId, cell.fn);
    const layer = target.kind === "intensity" ? "intensity" : target.kind === "emitter" ? "color" : target.key;
    if (!targets.some((id) => allRows.find((r) => r.fixtureId === id)?.cells.get(cell.fn)?.programmed)) return;
    setValues(knockout(values, targets, layer));
    announce(t("editor.sheet.cleared", { name: cell.name, count: targets.length }));
  };

  /** 单元格之间的方向键导航。 */
  const onGridKey = (e: KeyboardEvent<HTMLTableElement>) => {
    const el = e.target as HTMLElement;
    const key = el.dataset?.cell;
    if (!key || editing) return;
    const [r, c] = key.split(":").map(Number);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [r - 1, c],
      ArrowDown: [r + 1, c],
      ArrowLeft: [r, c - 1],
      ArrowRight: [r, c + 1],
      Home: [r, 0],
      End: [r, columns.length - 1],
    };
    const to = moves[e.key];
    if (!to) return;
    const next = tableRef.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(to[0], to[1])}"]`);
    if (next) next.focus();
    e.preventDefault();
  };

  const cellView = (row: SheetRow, rowIndex: number, colIndex: number, fn: ChannelFunction) => {
    const cell = row.cells.get(fn);
    const key = cellKey(rowIndex, colIndex);
    if (!cell) {
      return (
        <span data-cell={key} tabIndex={-1} aria-hidden className="block text-right text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          ·
        </span>
      );
    }
    const text = formatCell(cell, prefs.readout);
    const editable = cellTarget(cell.fn).kind !== "readonly";
    if (editing?.fixtureId === row.fixtureId && editing.fn === cell.fn) {
      return (
        <span
          // 打开编辑时输入框获得焦点并全选，直接输入新值
          ref={(el) => {
            const input = el?.querySelector("input");
            if (input && document.activeElement !== input) {
              input.focus();
              input.select();
            }
          }}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              pendingFocus.current = key;
              setEditing(null);
            }
          }}
        >
          <CommitInput
            className="num h-6 w-16 px-1 text-right text-xs"
            inputMode={prefs.readout === "hex" ? "text" : "numeric"}
            label={t("editor.sheet.editCellAs", { name: cell.name, unit: t(`editor.sheet.readouts.${prefs.readout}`) })}
            value={text}
            onCommit={(input) => {
              const v = parseCell(input, cell, prefs.readout);
              if (v === null) announce(t("editor.sheet.badValue"));
              else commit(row.fixtureId, cell.fn, v);
            }}
          />
        </span>
      );
    }
    const zero = cell.dmx === 0;
    const title = t("editor.sheet.cellTitle", { name: cell.name, dmx: cell.dmx, max: cell.max });
    return editable ? (
      <button
        type="button"
        data-cell={key}
        title={title}
        aria-label={t("editor.sheet.cellLabelAs", { name: cell.name, value: text, suffix: prefs.readout.startsWith("percent") ? "%" : "", unit: t(`editor.sheet.readouts.${prefs.readout}`) })}
        className={cn(
          "num w-full cursor-text rounded-sm px-1 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          cell.programmed && "bg-keyframe/25 font-semibold text-foreground",
          zero && !cell.programmed && "text-muted-foreground",
        )}
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ fixtureId: row.fixtureId, fn: cell.fn });
        }}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            clearLayer(row.fixtureId, cell);
          }
        }}
      >
        {text}
      </button>
    ) : (
      <span data-cell={key} tabIndex={-1} title={title} className="num block px-1 text-right text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {text}
      </span>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="toolbar" aria-label={t("editor.sheet.toolbar")} className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={t("editor.sheet.search")}
            placeholder={t("editor.sheet.search")}
            className="h-7 w-44 pr-6 pl-7 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button
              type="button"
              aria-label={t("editor.sheet.clearSearch")}
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          )}
        </div>
        <Segmented
          size="xs"
          ariaLabel={t("editor.sheet.filter")}
          value={prefs.filter}
          onChange={(filter) => setPrefs({ filter })}
          options={SHEET_FILTERS.map((f) => ({ value: f, label: t(`editor.sheet.filters.${f}`) }))}
        />
        <Select value={prefs.readout} onValueChange={(v) => setPrefs({ readout: v as SheetReadout })}>
          <SelectTrigger className="h-7 w-32 text-xs" aria-label={t("editor.sheet.readout")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHEET_READOUTS.map((r) => (
              <SelectItem key={r} value={r} className="text-xs">
                {t(`editor.sheet.readouts.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={prefs.sort} onValueChange={(v) => setPrefs({ sort: v as SheetSort })}>
          <SelectTrigger className="h-7 w-28 text-xs" aria-label={t("editor.sheet.sort")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHEET_SORTS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {t(`editor.sheet.sorts.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
              <Columns3 aria-hidden className="size-3.5" />
              {t("editor.sheet.columns")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel className="text-xs">{t("editor.sheet.columnGroups")}</DropdownMenuLabel>
            {presentGroups.map((g) => (
              <DropdownMenuCheckboxItem
                key={g}
                className="text-xs"
                checked={!prefs.hiddenGroups.includes(g)}
                onCheckedChange={(on) =>
                  setPrefs({ hiddenGroups: on ? prefs.hiddenGroups.filter((x) => x !== g) : [...prefs.hiddenGroups, g as AttributeGroup] })
                }
                onSelect={(e) => e.preventDefault()}
              >
                {t(`fixtures.groups.${g}`)}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem className="text-xs" checked={prefs.showModel} onCheckedChange={(on) => setPrefs({ showModel: on === true })} onSelect={(e) => e.preventDefault()}>
              {t("editor.sheet.model")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {hasPixels && (
          <>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("editor.sheet.expandAll")} title={t("editor.sheet.expandAll")} onClick={() => expandAll(true)}>
              <ChevronsUpDown aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("editor.sheet.collapseAll")} title={t("editor.sheet.collapseAll")} onClick={() => expandAll(false)}>
              <ChevronsDownUp aria-hidden />
            </Button>
          </>
        )}
        <span role="status" className="ml-auto text-[11px] text-muted-foreground">
          {t("editor.sheet.count", { shown: rows.filter((r) => r.head === null).length, total: project.fixtures.length })}
        </span>
        <HelpTip topic="editor.help.sheet" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyHint>{t("editor.sheet.noMatch")}</EmptyHint>
        ) : (
          <table ref={tableRef} className="w-max min-w-full border-collapse text-xs" aria-label={t("editor.sheet.title")} onKeyDown={onGridKey}>
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr className="border-b border-border">
                <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-2 py-1.5 text-left font-medium">
                  {t("editor.sheet.fixture")}
                </th>
                <th scope="col" className="px-1 py-1.5 text-left font-medium">
                  <span className="sr-only">{t("editor.sheet.output")}</span>
                </th>
                {prefs.showModel && (
                  <th scope="col" className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                    {t("editor.sheet.model")}
                  </th>
                )}
                <th scope="col" className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                  {t("editor.sheet.address")}
                </th>
                {columns.map((fn) => (
                  <th key={fn} scope="col" className="min-w-14 px-2 py-1.5 text-right font-medium">
                    {t(`fixtures.functions.${fn}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const isSelected = selected.has(row.fixtureId);
                const pixel = row.head !== null;
                const open = expanded.has(row.fixtureId);
                const label = pixel ? t("editor.patch.pixel", { n: row.head }) : row.name;
                const base = baseOf(row.fixtureId);
                const hovered = hoverId === base;
                const rgb = pixel ? null : colors.get(row.fixtureId);
                return (
                  <tr
                    key={row.fixtureId}
                    data-row-id={row.fixtureId}
                    aria-selected={isSelected}
                    className={cn("border-b border-border/60 hover:bg-surface-3", hovered && "bg-surface-3", isSelected && "bg-primary/10")}
                    onClick={(e) => pickRow(index, e)}
                    onMouseEnter={() => setHover(base)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <th scope="row" className={cn("sticky left-0 bg-surface-2 px-2 py-1 text-left font-normal", isSelected && "bg-primary/15")}>
                      <span className={cn("flex items-center gap-1", pixel && "pl-5")}>
                        {row.pixels > 0 && (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={t(open ? "editor.patch.collapsePixels" : "editor.patch.expandPixels", { name: row.name, count: row.pixels })}
                            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpanded(row.fixtureId);
                            }}
                          >
                            <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={pixel ? `${row.name} · ${label}` : undefined}
                          className="max-w-40 truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={row.modelName}
                          onClick={(e) => {
                            e.stopPropagation();
                            pickRow(index, e);
                          }}
                        >
                          {label}
                        </button>
                      </span>
                    </th>
                    <td className="px-1 py-1">
                      {rgb && (
                        <span
                          role="img"
                          aria-label={t("editor.sheet.outputColor", { r: rgb[0], g: rgb[1], b: rgb[2] })}
                          title={t("editor.sheet.outputColor", { r: rgb[0], g: rgb[1], b: rgb[2] })}
                          className="block size-3 rounded-sm border border-border bg-(--cue-color)"
                          style={{ "--cue-color": cssColor(rgb) } as CSSProperties}
                        />
                      )}
                    </td>
                    {prefs.showModel && <td className="max-w-40 truncate whitespace-nowrap px-2 py-1 text-muted-foreground">{pixel ? "" : row.modelName}</td>}
                    <td className="num whitespace-nowrap px-2 py-1 text-muted-foreground">{pixel ? "" : row.address}</td>
                    {columns.map((fn, col) => (
                      <td key={fn} className="px-1 py-0.5">
                        {cellView(row, index, col, fn)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
