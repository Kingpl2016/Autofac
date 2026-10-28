import { useRef, useState } from "react";

import { Input } from "@/components/ui/input";

interface CommitInputProps {
  /** 当前（已提交的）值 */
  value: string | number;
  /**
   * 提交新值：失去焦点或按 Enter 时，且文本与当前值不同才会调用。
   *
   * @param text 用户输入的文本。
   */
  onCommit: (text: string) => void;
  /** 无障碍名称（必填：这类输入往往没有可见标签） */
  label: string;
  className?: string;
  inputMode?: "numeric" | "text";
  /** 值为空时的占位文字（多选时显示“混合”） */
  placeholder?: string;
}

/**
 * “提交式”输入框：输入过程中只改本地草稿，失去焦点或按 Enter 才提交，按 Esc 放弃。
 *
 * 编辑器里每次提交都会产生一步撤销历史，所以不能每敲一个字符就写进工程。
 * 草稿为 `null` 时直接显示外部的值，因此外部值变化（撤销、重命名）能立刻反映出来，不需要 effect 同步。
 */
export function CommitInput({ value, onCommit, label, className, inputMode = "text", placeholder }: CommitInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc 要放弃草稿：blur 事件处理时拿到的还是旧的 draft，所以用 ref 传达“已取消”
  const cancelled = useRef(false);
  const shown = draft ?? String(value);

  const commit = () => {
    const discard = cancelled.current;
    cancelled.current = false;
    if (!discard && draft !== null && draft !== String(value)) onCommit(draft);
    setDraft(null);
  };

  return (
    <Input
      aria-label={label}
      className={className}
      inputMode={inputMode}
      placeholder={placeholder}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
