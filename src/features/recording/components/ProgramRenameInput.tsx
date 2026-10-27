import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ProgramRenameInputProps {
  /** 初始名称 */
  initial: string;
  /** Enter / ✓ 提交（值未裁剪，由调用方处理空串与未变化） */
  onCommit: (name: string) => void;
  /** Esc / ✕ 放弃 */
  onCancel: () => void;
}

/** 行内重命名：自动聚焦，Enter 提交、Esc 放弃，另有 ✓ / ✕ 按钮供指针操作。 */
export function ProgramRenameInput({ initial, onCommit, onCancel }: ProgramRenameInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Input
        autoFocus
        className="h-8 text-sm"
        aria-label={t("recording.libRename")}
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          // 不让表格的方向键 / 快捷键处理到输入框里的按键
          ev.stopPropagation();
          if (ev.key === "Enter") onCommit(draft);
          if (ev.key === "Escape") onCancel();
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={t("common.ok")}
        onClick={() => onCommit(draft)}
      >
        <Check />
      </Button>
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("common.cancel")} onClick={onCancel}>
        <X />
      </Button>
    </div>
  );
}
