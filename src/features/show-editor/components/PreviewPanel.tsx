import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createPreviewEvaluator } from "../lib/color";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { EmptyHint } from "./EmptyHint";
import { MediaPlayers } from "./MediaPlayers";
import { PanelFrame } from "./PanelFrame";

/**
 * 中间预览区：视频画面（有视频素材时）和每台灯具在播放头时刻的颜色。
 *
 * 颜色由前端镜像（`lib/color.ts`，与后端共用黄金向量）按工程计算，因此没有输出会话时拖动播放头也能预览；
 * 视频与音频随后端时钟同步播放（见 `MediaPlayers`）。
 */
export function PreviewPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const evaluate = useMemo(() => createPreviewEvaluator(project), [project]);
  const colors = evaluate(playheadMs);
  const fixtures = project.fixtures;

  return (
    <PanelFrame title={t("editor.preview.title")} className="bg-surface-1">
      <div className="flex flex-col gap-3 p-3">
        <MediaPlayers />
        {fixtures.length === 0 ? (
          <EmptyHint>{t("editor.preview.empty")}</EmptyHint>
        ) : (
          <ul
            aria-label={t("editor.preview.swatches", { count: fixtures.length })}
            className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2"
          >
            {fixtures.map((f) => {
              const [r, g, b] = colors.get(f.id) ?? [0, 0, 0];
              return (
                <li key={f.id} className="min-w-0" title={`${f.name} · U${f.universe} @${f.address}`}>
                  <div
                    className="h-10 rounded-md border border-border"
                    style={{ backgroundColor: `rgb(${r} ${g} ${b})` }}
                    role="img"
                    aria-label={t("editor.preview.swatch", { name: f.name, r, g, b })}
                  />
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
