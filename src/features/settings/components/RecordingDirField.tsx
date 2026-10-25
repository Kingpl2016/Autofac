import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderSearch, OctagonAlert, RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_START_FREE_BYTES, formatDiskBytes } from "@/shared/domain/disk";
import { pickDirectory } from "@/shared/tauri/directory";
import { recordingCheckDir, recordingOpenDir, type DirCheck } from "../lib/recordingDir";

/** 输入停顿多久后检查目录（毫秒）：避免每个按键都触发一次系统调用。 */
const CHECK_DEBOUNCE_MS = 400;

interface RecordingDirFieldProps {
  /** 设置草稿里的录制目录；空表示使用默认目录 */
  value: string;
  onChange: (next: string) => void;
}

/**
 * 录制目录设置行：输入框 + 浏览 / 打开目录 / 恢复默认，下方常驻帮助文字显示
 * 实际生效的目录与剩余空间，目录不可写时就地给出具体错误（`aria-describedby` 关联）。
 *
 * 检查针对**草稿值**，用户在保存前就能看到新目录是否可用。
 */
export function RecordingDirField({ value, onChange }: RecordingDirFieldProps) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<DirCheck | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // 草稿变化后稍等片刻再检查；结果在异步回调里写入，不在 effect 内同步 setState
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      recordingCheckDir(value)
        .then((c) => {
          if (!cancelled) setCheck(c);
        })
        .catch(() => {
          if (!cancelled) setCheck(null);
        });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  const browse = async () => {
    setBrowsing(true);
    try {
      const picked = await pickDirectory(value || check?.path);
      if (picked) onChange(picked);
    } catch (e: unknown) {
      toast.error(t("settings.recordingDirBrowseFailed", { reason: String(e) }));
    } finally {
      setBrowsing(false);
    }
  };

  const openDir = async () => {
    try {
      await recordingOpenDir(value);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      toast.error(
        raw === "not_a_directory"
          ? t("settings.recordingDirNotFolder")
          : t("settings.recordingDirOpenFailed", { reason: raw }),
      );
    }
  };

  const invalid = check !== null && !check.writable;
  const notFolder = check !== null && check.exists && !check.isDir;
  const disk = check?.disk;
  const blocked = disk !== undefined && !disk.canStart;
  const low = disk !== undefined && disk.level !== "ok";

  return (
    <div data-slot="setting-row" className="grid gap-2 px-5 py-3">
      <Label htmlFor="rec-dir" className="text-sm font-medium">
        {t("settings.recordingDir")}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="rec-dir"
          className="min-w-64 flex-1"
          placeholder={t("settings.recordingDirPlaceholder")}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby="rec-dir-help"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button variant="outline" onClick={() => void browse()} disabled={browsing}>
          <FolderSearch aria-hidden />
          {t("settings.recordingDirBrowse")}
        </Button>
        <Button variant="outline" onClick={() => void openDir()}>
          <FolderOpen aria-hidden />
          {t("settings.recordingDirOpen")}
        </Button>
        <Button variant="ghost" onClick={() => onChange("")} disabled={value.trim() === ""}>
          <RotateCcw aria-hidden />
          {t("settings.recordingDirReset")}
        </Button>
      </div>

      <div id="rec-dir-help" className="grid gap-1 text-xs">
        {invalid ? (
          <p className="flex items-start gap-2 text-destructive">
            <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {notFolder ? t("settings.recordingDirIsFile") : t("settings.recordingDirNotWritable")}
          </p>
        ) : (
          check && (
            <>
              <p className="break-all text-muted-foreground">
                {value.trim() === ""
                  ? t("settings.recordingDirUsingDefault", { path: check.path })
                  : t("settings.recordingDirEffective", { path: check.path })}
              </p>
              {disk && disk.freeBytes !== null && (
                <p
                  className={
                    blocked
                      ? "flex items-start gap-2 text-destructive"
                      : low
                        ? "flex items-start gap-2 text-warning"
                        : "text-muted-foreground"
                  }
                >
                  {(blocked || low) &&
                    (blocked ? (
                      <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    ))}
                  <span>
                    {t("settings.recordingDirFree", { free: formatDiskBytes(disk.freeBytes) })}
                    {blocked &&
                      ` · ${t("settings.recordingDirTooLow", { min: formatDiskBytes(MIN_START_FREE_BYTES) })}`}
                    {!blocked && low && ` · ${t("recording.diskLowTag")}`}
                  </span>
                </p>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
