import { useMemo, useRef, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { CENTER_VIEWS, useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageMonitor } from "../stage/StageMonitor";
import { EmptyHint } from "./EmptyHint";
import { FixtureSheet } from "./FixtureSheet";
import { MediaPlayers } from "./MediaPlayers";
import { PanelFrame } from "./PanelFrame";

/**
 * 中间预览区：视频画面（有视频素材时）和每台灯具在播放头时刻的颜色。
 *
 * 颜色由 WASM 版 show-engine（与后端输出同一份代码）按工程计算，叠加编程器的值；因此没有输出会话时
 * 拖动播放头也能预览。色块可以点选灯具（Ctrl 追加、Shift 连选），与编程器、Patch 面板共用选择。
 * 视频与音频随后端时钟同步播放（见 `MediaPlayers`）。
 */
export function PreviewPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const engine = useEngine();
  const evaluate = useMemo(() => createPreviewEvaluator(preview, engine), [preview, engine]);
  const colors = evaluate(playheadMs);
  const fixtures = project.fixtures;
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const values = useProgrammerStore((s) => s.values);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const programmed = useMemo(() => new Set(Object.keys(values)), [values]);
  const anchor = useRef<number | null>(null);
  const view = useEditorUiStore((s) => s.centerView);
  const setView = useEditorUiStore((s) => s.setCenterView);

  /** 点选：单击只选这一台，Ctrl / ⌘ 追加或取消，Shift 选连续一段（相对上次点选的灯）。 */
  const pick = (index: number, e: MouseEvent) => {
    const id = fixtures[index].id;
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      const range = fixtures.slice(a, b + 1).map((f) => f.id);
      setSelected(e.ctrlKey || e.metaKey ? [...new Set([...selectedIds, ...range])] : range);
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      setSelected(selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    } else {
      setSelected([id]);
    }
  };

  const viewSwitch = (
    <div role="radiogroup" aria-label={t("editor.preview.view")} className="flex rounded-md bg-surface-1 p-0.5">
      {CENTER_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          onClick={() => setView(v)}
          className={cn(
            "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === v ? "bg-surface-3 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`editor.preview.views.${v}`)}
        </button>
      ))}
    </div>
  );

  if (view === "stage") {
    return (
      <PanelFrame title={t("editor.preview.title")} className="bg-surface-1" actions={viewSwitch} noScroll>
        <div className="relative h-full min-h-0">
          <StageMonitor />
          {/* 视频画中画（没有视频时这里不显示任何东西，音频元素本身是隐藏的） */}
          <div className="pointer-events-none absolute bottom-10 right-2 w-1/3 max-w-72 [&_video]:max-h-40 [&_video]:shadow-lg">
            <MediaPlayers />
          </div>
        </div>
      </PanelFrame>
    );
  }

  if (view === "sheet") {
    return (
      <PanelFrame title={t("editor.preview.title")} className="bg-surface-1" actions={viewSwitch} noScroll>
        {/* 音视频必须保持挂载（声音继续随播放头走），灯具表视图下只是不显示画面 */}
        <div className="hidden">
          <MediaPlayers />
        </div>
        <FixtureSheet />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame title={t("editor.preview.title")} className="bg-surface-1" actions={viewSwitch}>
      <div className="flex flex-col gap-3 p-3">
        <MediaPlayers />
        {fixtures.length === 0 ? (
          <EmptyHint>{t("editor.preview.empty")}</EmptyHint>
        ) : (
          <ul
            aria-label={t("editor.preview.swatches", { count: fixtures.length })}
            className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2"
          >
            {fixtures.map((f, index) => {
              const [r, g, b] = colors.get(f.id) ?? [0, 0, 0];
              const isSelected = selectedSet.has(f.id);
              return (
                <li key={f.id} className="min-w-0" title={`${f.name} · U${f.universe} @${f.address}`}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={t("editor.preview.swatch", { name: f.name, r, g, b })}
                    onClick={(e) => pick(index, e)}
                    className={cn(
                      "relative block h-10 w-full cursor-pointer rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected ? "border-primary ring-2 ring-primary/60" : "border-border",
                    )}
                    style={{ backgroundColor: `rgb(${r} ${g} ${b})` }}
                  >
                    {programmed.has(f.id) && (
                      <span
                        aria-hidden
                        className="absolute right-1 top-1 size-1.5 rounded-full bg-keyframe"
                        title={t("editor.preview.inProgrammer")}
                      />
                    )}
                  </button>
                  <p className="mt-1 truncate text-center text-[11px] text-muted-foreground">{f.name}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PanelFrame>
  );
}
