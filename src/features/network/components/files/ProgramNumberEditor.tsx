import { useId, useState } from "react";
import { ArrowLeftRight, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  PROGRAM_NO_MAX,
  PROGRAM_NO_MIN,
  planSetNumber,
  smallestFreeProgramNo,
  touchesProgramNo,
  type ProgramAssignment,
} from "../../lib/files";
import type { NetFile } from "../../lib/types";

interface ProgramNumberEditorProps {
  file: NetFile;
  /** 设备上的全部文件，用来判断目标号是否被占用 */
  files: readonly NetFile[];
  /** 正在播放 / 暂停的节目号；不能被改动 */
  playingNo: number | null;
  /** 不可写（离线、无 SD 卡等）时只显示号码，不能修改 */
  disabled: boolean;
  /** 提交分配；返回是否成功（成功后关闭弹层） */
  onSubmit: (assignments: ProgramAssignment[], label: string) => Promise<boolean>;
}

/**
 * 节目号单元格：点击号码弹出小面板修改节目号。
 *
 * 目标号空闲就直接改；已被别的文件占用就在面板里写明“将与它互换”，确认后两个文件互换编号
 * （没有编号的文件不能抢别人的号）。正在播放的节目不能改号。
 */
export function ProgramNumberEditor({ file, files, playingNo, disabled, onSubmit }: ProgramNumberEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = file.program === null ? "—" : `#${file.program}`;

  if (disabled) {
    return <span className="tabular px-2 text-base font-semibold text-muted-foreground">{label}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("network.files.editProgram")}: ${file.name}`}
          title={t("network.files.editProgram")}
          className={cn(
            "group inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-base font-semibold tabular text-foreground transition-colors",
            "hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "data-[state=open]:bg-surface-3",
          )}
        >
          {file.program === null ? <span className="text-sm font-medium text-muted-foreground">{t("network.files.assignProgram")}</span> : label}
          <Pencil
            className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100 motion-reduce:transition-none"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* 每次打开都重新挂载，草稿从当前值开始 */}
        {open && (
          <EditorForm
            file={file}
            files={files}
            playingNo={playingNo}
            onCancel={() => setOpen(false)}
            onSubmit={async (assignments, text) => {
              if (await onSubmit(assignments, text)) setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface EditorFormProps {
  file: NetFile;
  files: readonly NetFile[];
  playingNo: number | null;
  onCancel: () => void;
  onSubmit: (assignments: ProgramAssignment[], label: string) => Promise<void>;
}

function EditorForm({ file, files, playingNo, onCancel, onSubmit }: EditorFormProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(() => String(file.program ?? smallestFreeProgramNo(files) ?? ""));
  const [busy, setBusy] = useState(false);

  const no = draft.trim() === "" ? Number.NaN : Number(draft);
  const plan = planSetNumber(files, file.name, no);
  const playingBlocked =
    (plan.kind === "assign" || plan.kind === "swap") && playingNo !== null && touchesProgramNo(files, plan.assignments, playingNo);

  let message: string | null = null;
  let tone: "error" | "warning" | "muted" = "muted";
  if (plan.kind === "invalid") {
    message = t("network.files.programInvalid", { min: PROGRAM_NO_MIN, max: PROGRAM_NO_MAX });
    tone = "error";
  } else if (playingBlocked) {
    message = t("network.files.programPlaying", { no: playingNo });
    tone = "error";
  } else if (plan.kind === "taken") {
    message = t("network.files.programTaken", { no, other: plan.other });
    tone = "error";
  } else if (plan.kind === "swap") {
    message = t("network.files.programSwap", { no, other: plan.other });
    tone = "warning";
  }

  const canSubmit = (plan.kind === "assign" || plan.kind === "swap") && !playingBlocked && !busy;

  const submit = async () => {
    if (!canSubmit || (plan.kind !== "assign" && plan.kind !== "swap")) return;
    setBusy(true);
    try {
      await onSubmit(plan.assignments, t("network.files.renumbered", { name: file.name, no }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>{t("network.files.colProgram")}</Label>
        <Input
          id={inputId}
          autoFocus
          type="number"
          inputMode="numeric"
          min={PROGRAM_NO_MIN}
          max={PROGRAM_NO_MAX}
          step={1}
          className="h-9 tabular"
          value={draft}
          disabled={busy}
          aria-invalid={tone === "error"}
          aria-describedby={hintId}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
        />
        <p
          id={hintId}
          role={tone === "error" ? "alert" : undefined}
          className={cn(
            "min-h-4 text-xs",
            tone === "error" && "text-destructive",
            tone === "warning" && "flex items-start gap-1.5 text-foreground",
            tone === "muted" && "text-muted-foreground",
          )}
        >
          {tone === "warning" && <ArrowLeftRight className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
          <span>{message ?? t("network.files.programRange", { min: PROGRAM_NO_MIN, max: PROGRAM_NO_MAX })}</span>
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {plan.kind === "swap" ? t("network.files.programSwapBtn") : t("common.confirm")}
        </Button>
      </div>
    </form>
  );
}
