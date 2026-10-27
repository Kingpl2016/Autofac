import { useTranslation } from "react-i18next";
import { FileAudio, FileVideo, FolderSearch, Loader2, Plus, TriangleAlert, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { pickMediaFiles } from "@/shared/tauri/pickers";
import { importMediaPaths, loadMedia, relinkMediaTo } from "../hooks/mediaActions";
import { MEDIA_EXTENSIONS } from "../lib/media";
import { removeMedia, setMediaOffset } from "../lib/ops";
import type { MediaRef } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/** 素材库里的一个素材：类型图标、名称、时长、状态，以及偏移 / 重新链接 / 移除。 */
function MediaRow({ media }: { media: MediaRef }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const runtime = useMediaStore((s) => s.items[media.id]);
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
        <Icon className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm" title={media.path}>
          {media.name}
        </span>
        <span className="num shrink-0 text-xs text-muted-foreground">{formatTimecode(media.durationMs)}</span>
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
        <label className="flex items-center gap-1">
          {t("editor.media.offset")}
          <CommitInput
            className="num h-7 w-20 px-1.5 text-xs"
            inputMode="numeric"
            label={t("editor.media.offsetOf", { name: media.name })}
            value={media.offsetMs}
            onCommit={(text) => {
              const n = Number(text);
              if (Number.isFinite(n)) update((d) => setMediaOffset(d, media.id, n));
            }}
          />
          ms
        </label>
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
 * 素材库的“音视频”标签：导入音乐 / 视频，调整相对时间线的偏移，重新链接丢失的文件。
 *
 * 素材只被引用，不复制进工程；也可以直接把文件从系统文件管理器拖进窗口。
 * 第一个音频是主素材：时间线上显示它的波形，播放时与灯光同步。
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
