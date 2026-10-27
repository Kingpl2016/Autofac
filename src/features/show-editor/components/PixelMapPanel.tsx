import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Grid2x2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { bakePixelMap, VideoFrameSource } from "../hooks/pixelMapActions";
import { DEFAULT_PIXEL_MAP, PIXEL_MAP_FPS, type FrameSource } from "../lib/pixelMap";
import type { MediaClip } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 打开帧源（测试可替换）。 */
export type OpenFrameSource = (url: string) => Promise<FrameSource & { dispose?: () => void }>;

/**
 * 像素映射（视频片段的属性里）：按灯具在舞台上的位置从画面取色，烘焙成同一时间范围内的场景片段。
 *
 * 参与的灯具为当前选中的灯具（没有选中时为全部）；可选取样帧率、亮度是否跟随画面、左右 / 上下翻转。
 * 烘焙时显示进度，可取消；完成后选中新片段。
 */
export function PixelMapPanel({ clip, open = VideoFrameSource.open }: { clip: MediaClip; open?: OpenFrameSource }) {
  const { t } = useTranslation();
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const selected = useEditorUiStore((s) => s.selectedFixtureIds);
  const url = useMediaStore((s) => (s.items[clip.mediaId]?.status === "ready" ? s.items[clip.mediaId]?.url : undefined));
  const [fps, setFps] = useState<number>(DEFAULT_PIXEL_MAP.fps);
  const [follow, setFollow] = useState(DEFAULT_PIXEL_MAP.followBrightness);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const chosen = fixtures.filter((f) => selected.includes(f.id));
  const targets = (chosen.length > 0 ? chosen : fixtures).map((f) => f.id);
  const running = progress !== null;

  const bake = async () => {
    if (!url || targets.length === 0) return;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ done: 0, total: 1 });
    let source: Awaited<ReturnType<OpenFrameSource>> | null = null;
    try {
      source = await open(url);
      const id = await bakePixelMap({
        clipId: clip.id,
        fixtureIds: targets,
        options: { ...DEFAULT_PIXEL_MAP, fps, followBrightness: follow, flipX, flipY },
        source,
        onProgress: (done, total) => setProgress({ done, total }),
        signal: controller.signal,
      });
      if (id) {
        useEditorUiStore.getState().selectCues([id]);
        announce(t("editor.pixelMap.done", { count: targets.length }));
      } else {
        setError(t("editor.pixelMap.noRoom"));
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(t("editor.pixelMap.failed"));
      else announce(t("editor.pixelMap.cancelled"));
    } finally {
      source?.dispose?.();
      abort.current = null;
      setProgress(null);
    }
  };

  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <section aria-label={t("editor.pixelMap.title")} className="grid gap-2 rounded-md border border-border p-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium">
        <Grid2x2 aria-hidden className="size-3.5" />
        {t("editor.pixelMap.title")}
      </h4>
      <p className="text-xs text-muted-foreground">
        {t(chosen.length > 0 ? "editor.pixelMap.targetsSelected" : "editor.pixelMap.targetsAll", { count: targets.length })}
      </p>
      <div role="radiogroup" aria-label={t("editor.pixelMap.fps")} className="flex items-center gap-1 text-xs">
        <span className="mr-1 text-muted-foreground">{t("editor.pixelMap.fps")}</span>
        {PIXEL_MAP_FPS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={fps === v}
            disabled={running}
            onClick={() => setFps(v)}
            className={cn(
              "num cursor-pointer rounded px-2 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              fps === v ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      {(
        [
          ["follow", follow, setFollow],
          ["flipX", flipX, setFlipX],
          ["flipY", flipY, setFlipY],
        ] as const
      ).map(([key, value, set]) => (
        <label key={key} className="flex items-center justify-between gap-2 text-xs">
          <span>{t(`editor.pixelMap.${key}`)}</span>
          <Switch aria-label={t(`editor.pixelMap.${key}`)} checked={value} disabled={running} onCheckedChange={set} />
        </label>
      ))}
      {running ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={t("editor.pixelMap.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="num w-9 text-right text-xs">{percent}%</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={t("editor.pixelMap.cancel")}
            onClick={() => abort.current?.abort()}
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" className="h-8" disabled={!url || targets.length === 0} onClick={() => void bake()}>
          {t("editor.pixelMap.bake")}
        </Button>
      )}
      {!url && <p className="text-xs text-muted-foreground">{t("editor.pixelMap.notReady")}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
