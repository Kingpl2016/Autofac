import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { ArrowDownToLine, FileAudio, FileVideo, FolderSearch, Loader2, Plus, TriangleAlert, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { pickMediaFiles } from "@/shared/tauri/pickers";
import { importMediaPaths, loadMedia, placeMediaOnTimeline, relinkMediaTo } from "../hooks/mediaActions";
import { MEDIA_EXTENSIONS } from "../lib/media";
import { removeMedia } from "../lib/ops";
import type { MediaRef } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 拖拽数据：标明被拖的是素材库里的音视频。 */
export interface MediaDragData {
  kind: "media";
  mediaId: string;
  name: string;
  mediaKind: MediaRef["kind"];
}

/** 素材芯片（拖拽浮层用）。 */
export function MediaChip({ name, mediaKind }: { name: string; mediaKind: MediaRef["kind"] }) {
  const Icon = mediaKind === "video" ? FileVideo : FileAudio;
  return (
    <span className="flex items-center gap-2 rounded-md border border-primary bg-card px-2.5 py-2 text-sm shadow-lg">
      <Icon aria-hidden className="size-4 shrink-0 text-primary" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * 素材库里的一个素材：类型图标（拖拽把手，拖到时间线上放一个片段）、名称、时长、
 * 放到播放头、状态、使用次数，以及重新链接 / 移除。
 */
function MediaRow({ media }: { media: MediaRef }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const usage = useProjectStore((s) => s.project.mediaClips.filter((c) => c.mediaId === media.id).length);
  const runtime = useMediaStore((s) => s.items[media.id]);
  const data: MediaDragData = { kind: "media", mediaId: media.id, name: media.name, mediaKind: media.kind };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `media:${media.id}`, data });
  const status = runtime?.status ?? "loading";
  const Icon = media.kind === "video" ? FileVideo : FileAudio;
  const broken = status === "missing" || status === "error";

  const relink = async () => {
    const [path] = await pickMediaFiles(t("editor.media.fileType"), MEDIA_EXTENSIONS);
    if (path) await relinkMediaTo(media.id, path);
  };

  return (
    <li className="rounded-md border border-border bg-card px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button
          ref={setNodeRef}
          type="button"
          {...listeners}
          {...attributes}
          aria-label={t("editor.media.drag", { name: media.name })}
          title={t("editor.media.drag", { name: media.name })}
          className={cn(
            "flex size-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging && "opacity-40",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm" title={media.path}>
          {media.name}
        </span>
        <span className="num shrink-0 text-xs text-muted-foreground">{formatTimecode(media.durationMs)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("editor.media.placeAtPlayhead", { name: media.name })}
          title={t("editor.media.placeAtPlayhead", { name: media.name })}
          disabled={broken}
          onClick={() => {
            const id = placeMediaOnTimeline(media.id, useEditorUiStore.getState().playheadMs);
            if (id) useEditorUiStore.getState().selectMediaClips([id]);
          }}
        >
          <ArrowDownToLine aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("editor.media.remove", { name: media.name })}
          title={t("editor.media.remove", { name: media.name })}
          onClick={() => update((d) => removeMedia(d, media.id))}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
        {status === "loading" && (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {t("editor.media.loading")}
          </span>
        )}
        {broken && (
          <>
            <Badge variant="destructive">
              <TriangleAlert className="size-3" aria-hidden />
              {status === "missing" ? t("editor.media.missing") : t("editor.media.unusable")}
            </Badge>
            <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => void relink()}>
              <FolderSearch aria-hidden />
              {t("editor.media.relink")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void loadMedia(media)}
            >
              {t("editor.media.recheck")}
            </Button>
          </>
        )}
        <span>{t("editor.media.usage", { count: usage })}</span>
        {runtime?.unplayable && (
          <span className="flex items-center gap-1 text-warning">
            <TriangleAlert className="size-3" aria-hidden />
            {t("editor.media.unplayable")}
          </span>
        )}
        {runtime?.status === "ready" && !runtime.peaks && media.kind === "video" && (
          <span>{t("editor.media.noAudio")}</span>
        )}
      </div>
    </li>
  );
}

/**
 * 素材库的“音视频”标签：导入音乐 / 视频（同时放到时间线 0 点的媒体轨道上），把素材拖到 / 放到时间线上
 * （同一素材可以放多次），重新链接丢失的文件。
 *
 * 素材只被引用，不复制进工程；也可以直接把文件从系统文件管理器拖进窗口。
 */
export function MediaTab() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => s.project.media);

  const choose = async () => {
    const paths = await pickMediaFiles(t("editor.media.fileType"), MEDIA_EXTENSIONS);
    if (paths.length > 0) await importMediaPaths(paths);
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void choose()}>
        <Plus aria-hidden />
        {t("editor.media.import")}
      </Button>
      <p className="px-1 text-xs text-muted-foreground">{t("editor.media.hint")}</p>
      {media.length > 0 && (
        <>
          <Label className="sr-only">{t("editor.media.listLabel")}</Label>
          <ul aria-label={t("editor.media.listLabel")} className="flex flex-col gap-1.5">
            {media.map((m) => (
              <MediaRow key={m.id} media={m} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
