import { useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ChannelFunction } from "@/features/fixtures";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { buildSheet, cellTarget, manualEmitters, sheetColumns, type SheetCell } from "../lib/fixtureSheet";
import { programAttr, programColor, programIntensity } from "../lib/programmer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { EmptyHint } from "./EmptyHint";

/** 正在编辑的单元格。 */
interface EditingCell {
  fixtureId: string;
  fn: ChannelFunction;
}

/**
 * 灯具表（Fixture Sheet）：每台灯一行、每种功能一列，显示播放头时刻的实际输出（百分比）。
 *
 * - 点行选灯（Ctrl 追加、Shift 连选），与编程器、预览区共用选择；
 * - 编程器里有值的单元格高亮；
 * - 点单元格输入百分比写入编程器——这台灯在选择里时，同时写给所有选中且有该功能的灯。
 */
export function FixtureSheet() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const values = useProgrammerStore((s) => s.values);
  const setValues = useProgrammerStore((s) => s.setValues);
  const engine = useEngine();
  const evaluate = useMemo(() => createDmxEvaluator(preview, engine), [preview, engine]);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const anchor = useRef<number | null>(null);

  const frames = new Map<number, Uint8Array>();
  const frameOf = (u: number) => {
    let f = frames.get(u);
    if (!f) {
      f = evaluate(playheadMs, u);
      frames.set(u, f);
    }
    return f;
  };
  const rows = buildSheet(project, frameOf, values);
  const columns = sheetColumns(rows);
  const selected = new Set(selectedIds);

  if (rows.length === 0) return <EmptyHint>{t("editor.preview.empty")}</EmptyHint>;

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

  /** 写入编程器：作用于这台灯；它在选择里时作用于全部选中且有该功能的灯。 */
  const commit = (fixtureId: string, fn: ChannelFunction, percent: number) => {
    const fraction = Math.min(1, Math.max(0, percent / 100));
    const targets = selected.has(fixtureId)
      ? rows.filter((r) => selected.has(r.fixtureId) && r.cells.has(fn)).map((r) => r.fixtureId)
      : [fixtureId];
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

  const cellView = (fixtureId: string, cell: SheetCell | undefined) => {
    if (!cell) return <span aria-hidden className="text-muted-foreground/40">·</span>;
    const percent = Math.round(cell.fraction * 100);
    const editable = cellTarget(cell.fn).kind !== "readonly";
    if (editing?.fixtureId === fixtureId && editing.fn === cell.fn) {
      return (
        <span
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") setEditing(null);
          }}
        >
          <CommitInput
            className="num h-6 w-14 px-1 text-right text-xs"
            inputMode="numeric"
            label={t("editor.sheet.editCell", { name: cell.name })}
            value={percent}
            onCommit={(text) => {
              const n = Number(text);
              if (Number.isFinite(n)) commit(fixtureId, cell.fn, n);
            }}
          />
        </span>
      );
    }
    const title = t("editor.sheet.cellTitle", { name: cell.name, dmx: cell.dmx, max: cell.max });
    return editable ? (
      <button
        type="button"
        title={title}
        aria-label={t("editor.sheet.cellLabel", { name: cell.name, percent })}
        className={cn(
          "num w-full cursor-text rounded-sm px-1 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          cell.programmed && "bg-keyframe/25 font-semibold text-foreground",
          percent === 0 && !cell.programmed && "text-muted-foreground",
        )}
        onClick={(e) => {
          e.stopPropagation();
          setEditing({ fixtureId, fn: cell.fn });
        }}
      >
        {percent}
      </button>
    ) : (
      <span title={title} className="num block px-1 text-right text-muted-foreground">
        {percent}
      </span>
    );
  };

  return (
    <div className="h-full overflow-auto">
      <table className="w-max min-w-full border-collapse text-xs" aria-label={t("editor.sheet.title")}>
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr className="border-b border-border">
            <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-2 py-1.5 text-left font-medium">
              {t("editor.sheet.fixture")}
            </th>
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
            return (
              <tr
                key={row.fixtureId}
                aria-selected={isSelected}
                className={cn("border-b border-border/60 hover:bg-surface-3", isSelected && "bg-primary/10")}
                onClick={(e) => pickRow(index, e)}
              >
                <th scope="row" className={cn("sticky left-0 bg-surface-2 px-2 py-1 text-left font-normal", isSelected && "bg-primary/15")}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    className="max-w-40 truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={row.modelName}
                    onClick={(e) => {
                      e.stopPropagation();
                      pickRow(index, e);
                    }}
                  >
                    {row.name}
                  </button>
                </th>
                <td className="num whitespace-nowrap px-2 py-1 text-muted-foreground">{row.address}</td>
                {columns.map((fn) => (
                  <td key={fn} className="px-1 py-0.5">
                    {cellView(row.fixtureId, row.cells.get(fn))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
