import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { HeaderInfo, HeaderIssue } from "../lib/types";

/** 本程序写入的格式版本（与 `artrec_core::VER_MAJOR` / `VER_MINOR` 一致）。 */
const OWN_VERSION = "1.0";

/** 问题 → 文案键。 */
const ISSUE_LABEL: Record<HeaderIssue, string> = {
  emptyProgram: "recording.hdrEmpty",
  durationMismatch: "recording.hdrDurationMismatch",
  newerMinor: "recording.hdrNewerMinor",
};
const ISSUE_HINT: Record<HeaderIssue, string> = {
  emptyProgram: "recording.hdrEmptyHint",
  durationMismatch: "recording.hdrDurationMismatchHint",
  newerMinor: "recording.hdrNewerMinorHint",
};

interface TagProps {
  label: string;
  hint: string;
  variant: "outline" | "warning";
  warn?: boolean;
}

/** 一个带说明浮层的标签：可键盘聚焦，悬停 / 聚焦时显示说明。 */
function Tag({ label, hint, variant, warn = false }: TagProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // 可聚焦，键盘用户也能读到说明
          tabIndex={0}
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant={variant}>
            {warn && <TriangleAlert className="size-3" aria-hidden />}
            {label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{hint}</TooltipContent>
    </Tooltip>
  );
}

interface ProgramHeaderTagsProps {
  /** 文件头派生信息；为空时不渲染 */
  header: HeaderInfo | null | undefined;
  /** 只显示需要注意的标签（差分帧、文件头问题）；没有时不渲染。用于节目库的紧凑行 */
  warningsOnly?: boolean;
}

/**
 * 节目库卡片上由文件头（A 区）派生的标签：格式版本与压缩、循环标志、差分帧提示、问题告警。
 *
 * 只读后端在列举节目库时顺带解析的文件头字段，不额外读取文件。
 */
export function ProgramHeaderTags({ header, warningsOnly = false }: ProgramHeaderTagsProps) {
  const { t } = useTranslation();
  if (!header) return null;
  if (warningsOnly && !header.diffFrames && header.issues.length === 0) return null;

  const version = `${header.verMajor}.${header.verMinor}`;
  const compression =
    header.compression === "zstd"
      ? t("recording.hdrZstd", { level: header.compressLevel })
      : t("recording.hdrNoCompress");
  const formatHint = [
    t("recording.hdrFormatHint", { version, compression }),
    header.frameIndexAtTail ? t("recording.hdrIndexAtTail") : t("recording.hdrIndexAfterTable"),
  ].join(" ");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap items-center gap-1.5" aria-label={t("recording.hdrTags")} role="group">
        {!warningsOnly && (
          <Tag
            variant="outline"
            label={t("recording.hdrFormat", { version, compression })}
            hint={formatHint}
          />
        )}
        {!warningsOnly && header.loopFlag && (
          <Tag variant="outline" label={t("recording.hdrLoop")} hint={t("recording.hdrLoopHint")} />
        )}
        {header.diffFrames && (
          <Tag
            variant="warning"
            warn
            label={t("recording.hdrDiff")}
            hint={t("recording.hdrDiffHint")}
          />
        )}
        {header.issues.map((issue) => (
          <Tag
            key={issue}
            variant="warning"
            warn
            label={t(ISSUE_LABEL[issue])}
            hint={t(ISSUE_HINT[issue], { version, own: OWN_VERSION })}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
