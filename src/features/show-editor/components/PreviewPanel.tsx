import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { CENTER_VIEWS, useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import type { RecentFile } from "../stores/useRecentFilesStore";
import { StageMonitor } from "../stage/StageMonitor";
import { EmptyHint } from "./EmptyHint";
import { FixtureSheet } from "./FixtureSheet";
import { MediaPlayers } from "./MediaPlayers";
import { PanelFrame } from "./PanelFrame";
import { RecentFilesList } from "./RecentFilesList";
import { SwatchView } from "./SwatchView";

/**
 * 中间预览区：视频画面（有视频素材时）和每台灯具在播放头时刻的颜色。
 *
 * 颜色由 WASM 版 show-engine（与后端输出同一份代码）按工程计算，叠加编程器的值；因此没有输出会话时
 * 拖动播放头也能预览。默认显示色块（按 Universe 分区，见 `SwatchView`），视图选择会记住。
 * 视频与音频随后端时钟同步播放（见 `MediaPlayers`）。还没有灯具时，色块视图下列出最近的 5 个节目。
 */
export function PreviewPanel({ onOpenRecent }: { onOpenRecent?: (item: RecentFile) => void }) {
  const { t } = useTranslation();
  const fixtureCount = useProjectStore((s) => s.project.fixtures.length);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const engine = useEngine();
  const evaluate = useMemo(() => createPreviewEvaluator(preview, engine), [preview, engine]);
  const view = useEditorPrefsStore((s) => s.centerView);
  const setView = useEditorPrefsStore((s) => s.setCenterView);

  const viewSwitch = (
    <div role="radiogroup" aria-label={t("editor.preview.view")} data-tour="preview-views" className="flex rounded-md bg-surface-1 p-0.5">
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
        {fixtureCount === 0 ? (
          <>
            <EmptyHint>{t("editor.preview.empty")}</EmptyHint>
            {onOpenRecent && <RecentFilesList limit={5} onOpen={onOpenRecent} className="mx-auto w-full max-w-sm rounded-md border border-border bg-card p-1" />}
          </>
        ) : (
          <SwatchView colors={evaluate(playheadMs)} />
        )}
      </div>
    </PanelFrame>
  );
}
