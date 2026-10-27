import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, CopyPlus, FileInput, Library, RefreshCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDurationUs } from "@/features/recording";

/** 结果去向。 */
export type OutputMode = "new" | "replace";

/** 编辑结果的摘要。 */
export interface EditSummary {
  /** 结果时长（微秒） */
  durationUs: number;
  /** 原节目时长（微秒） */
  sourceUs: number;
  /** 保留的片段数 */
  segments: number;
  /** 保留 / 全部 Universe 数 */
  universes: number;
  totalUniverses: number;
}

/** 一次成功导出的结果（显示完成状态）。 */
export interface ExportDone {
  path: string;
  name: string;
  durationUs: number;
  replaced: boolean;
}

interface EditOutputPanelProps {
  mode: OutputMode;
  onModeChange: (mode: OutputMode) => void;
  name: string;
  onNameChange: (name: string) => void;
  /** 编辑器节目只能另存（下次保存工程时会重新生成 `.artrec`，覆盖编辑结果） */
  replaceDisabled: boolean;
  summary: EditSummary;
  /** 是否有修改（没有修改时替换没有意义） */
  dirty: boolean;
  /** 导出条件不满足时的原因；为空表示可以导出 */
  blockReason: string;
  running: boolean;
  /** 0..1 */
  progress: number;
  /** 最近一次成功导出；非空时显示完成状态 */
  done: ExportDone | null;
  onExport: () => void;
  onCancelExport: () => void;
  onViewResult: () => void;
  onContinue: () => void;
}

/** 与后端 `sanitize_file_stem` 一致地预览文件名主干（非法字符替换为 `_`，最长 80 字符）。 */
function previewStem(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").trim().replace(/^\.+|\.+$/g, "").trim();
  return [...cleaned].slice(0, 80).join("").trim() || "recording";
}

interface ChoiceProps {
  name: string;
  value: OutputMode;
  checked: boolean;
  disabled: boolean;
  icon: ReactNode;
  title: string;
  desc: string;
  danger?: boolean;
  onSelect: () => void;
}

/** 单选卡片：整张卡可点击，内部是原生单选框（方向键在两张卡之间切换，读屏读出标题与说明）。 */
function Choice({ name, value, checked, disabled, icon, title, desc, danger, onSelect }: ChoiceProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "relative flex gap-3 rounded-lg border p-3 transition-colors duration-150 motion-reduce:transition-none",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent/40",
        checked
          ? danger
            ? "border-destructive bg-destructive/10"
            : "border-primary bg-primary/10"
          : "border-border bg-surface-2",
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        className="sr-only"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-desc`}
        onChange={onSelect}
      />
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          checked ? (danger ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground") : "bg-surface-3 text-muted-foreground",
          "[&_svg]:size-4",
        )}
      >
        {icon}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span id={`${id}-desc`} className="text-xs text-muted-foreground">
          {desc}
        </span>
      </span>
      {/* 选中标记：图形表达，不只靠颜色 */}
      <span
        aria-hidden
        className={cn(
          "absolute right-3 top-3 size-4 rounded-full border-2",
          checked ? (danger ? "border-destructive bg-destructive" : "border-primary bg-primary") : "border-muted-foreground/50",
        )}
      >
        {checked && <span className="absolute inset-1 rounded-full bg-background" />}
      </span>
    </label>
  );
}

/**
 * 输出设置（编辑页右下）：
 *
 * 1. 结果摘要：时长（相对原节目的变化）、片段数、Universe 数；
 * 2. 去向：两张单选卡片——另存为新节目（默认，原节目不变）/ 替换原节目（危险，原文件进回收站）；
 * 3. 另存时填写名称，实时预览将要保存的文件名；
 * 4. 主按钮的文字就是将要发生的动作（“另存为新节目”/“替换原节目”），Ctrl+S 同样触发；
 *    不能导出时在按钮旁说明原因。导出中按钮换成进度与“取消”。
 * 5. 完成后留在本页，显示结果与“在节目库中查看”“继续编辑”。
 */
export function EditOutputPanel({
  mode,
  onModeChange,
  name,
  onNameChange,
  replaceDisabled,
  summary,
  dirty,
  blockReason,
  running,
  progress,
  done,
  onExport,
  onCancelExport,
  onViewResult,
  onContinue,
}: EditOutputPanelProps) {
  const { t } = useTranslation();
  const groupName = useId();
  const nameId = useId();
  const nameMissing = mode === "new" && name.trim() === "";
  const unchangedReplace = mode === "replace" && !dirty;
  const reason = blockReason || (nameMissing ? t("library.editNameRequired") : "") || (unchangedReplace ? t("library.editNothingChanged") : "");
  const deltaUs = summary.durationUs - summary.sourceUs;

  if (done) {
    return (
      <div className="grid gap-4" role="status">
        <div className="flex items-start gap-3">
          <CircleCheck className="mt-0.5 size-6 shrink-0 text-success" aria-hidden />
          <div className="grid gap-1">
            <p className="font-medium">{t(done.replaced ? "library.editDoneReplaced" : "library.editDoneSaved")}</p>
            <p className="text-sm text-muted-foreground">
              {done.name} · <span className="num">{formatDurationUs(done.durationUs)}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onViewResult}>
            <Library />
            {t("library.editViewResult")}
          </Button>
          <Button variant="outline" onClick={onContinue}>
            {t("library.editContinue")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {/* 结果摘要 */}
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-2 p-3">
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">{t("library.editSumDuration")}</dt>
          <dd className="num text-sm font-semibold">
            {formatDurationUs(summary.durationUs)}
            {deltaUs !== 0 && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">−{formatDurationUs(-deltaUs)}</span>
            )}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">{t("library.editSumSegments")}</dt>
          <dd className="num text-sm font-semibold">{summary.segments}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">{t("library.colUniverses")}</dt>
          <dd className="num text-sm font-semibold">
            {summary.universes} / {summary.totalUniverses}
          </dd>
        </div>
      </dl>

      {/* 去向 */}
      <fieldset className="grid gap-2" disabled={running}>
        <legend className="mb-1 text-sm font-medium">{t("library.editOutput")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice
            name={groupName}
            value="new"
            checked={mode === "new"}
            disabled={running}
            icon={<CopyPlus />}
            title={t("library.editOutputNew")}
            desc={t("library.editOutputNewDesc")}
            onSelect={() => onModeChange("new")}
          />
          <Choice
            name={groupName}
            value="replace"
            checked={mode === "replace"}
            disabled={running || replaceDisabled}
            icon={<FileInput />}
            title={t("library.editOutputReplace")}
            desc={replaceDisabled ? t("library.editReplaceEditable") : t("library.editOutputReplaceDesc")}
            danger
            onSelect={() => onModeChange("replace")}
          />
        </div>
      </fieldset>

      {mode === "new" ? (
        <div className="grid gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t("library.editOutputName")}
          </label>
          <Input
            id={nameId}
            className="h-10"
            value={name}
            disabled={running}
            aria-invalid={nameMissing || undefined}
            aria-describedby={`${nameId}-hint`}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !reason && !running) onExport();
            }}
          />
          <p id={`${nameId}-hint`} className={cn("text-xs", nameMissing ? "text-destructive" : "text-muted-foreground")}>
            {nameMissing ? t("library.editNameRequired") : t("library.editFilePreview", { file: `${previewStem(name)}.artrec` })}
          </p>
        </div>
      ) : (
        <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("library.editReplaceWarn")}
        </p>
      )}

      {running ? (
        <div className="grid gap-2" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-sm">
            <span>{t("library.editExporting", { pct: Math.round(progress * 100) })}</span>
            <Button variant="outline" size="sm" className="h-9" onClick={onCancelExport}>
              {t("common.cancel")}
            </Button>
          </div>
          <progress className="h-2 w-full accent-primary" max={1} value={progress} />
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Button
            className="w-full"
            variant={mode === "replace" ? "destructive" : "default"}
            disabled={Boolean(reason)}
            aria-keyshortcuts="Control+S"
            aria-describedby={reason ? `${nameId}-reason` : undefined}
            onClick={onExport}
          >
            {mode === "replace" ? <RefreshCcw /> : <CopyPlus />}
            {mode === "replace" ? t("library.editExportReplace") : t("library.editExportNew")}
          </Button>
          <p id={`${nameId}-reason`} className="text-center text-xs text-muted-foreground">
            {reason || t("library.editExportHint")}
          </p>
        </div>
      )}
    </div>
  );
}
