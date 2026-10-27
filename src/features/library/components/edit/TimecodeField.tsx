import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatTimecode, parseTimecode } from "../../lib/timecode";

interface TimecodeFieldProps {
  label: string;
  /** 当前值（微秒） */
  value: number;
  /** 提交新值（微秒）；调用方负责钳制到合法范围 */
  onCommit: (us: number) => void;
  disabled?: boolean;
}

/**
 * 时间码输入（`m:ss.mmm`）：失焦或 Enter 时解析提交，Esc 还原；无法解析时在字段下方说明格式。
 * 以当前值为 key 挂载，外部修改（拖动、撤销）后自动显示最新值。
 */
export function TimecodeField({ label, value, onCommit, disabled }: TimecodeFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(() => formatTimecode(value));
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    const us = parseTimecode(draft);
    if (us === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(us);
    setDraft(formatTimecode(us));
  };

  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        className={cn("num h-10 w-36", invalid && "border-destructive")}
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-err` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setInvalid(false);
            setDraft(formatTimecode(value));
          }
        }}
      />
      {invalid && (
        <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
          {t("library.timecodeInvalid")}
        </p>
      )}
    </div>
  );
}
