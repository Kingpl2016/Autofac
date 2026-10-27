import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { OctagonAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { parseUniverseToken, splitUniverseInput } from "../lib/recordingPreset";

interface UniverseTokenInputProps {
  /** 输入框 id（供外部 `<Label htmlFor>` 关联） */
  id: string;
  /** 片段列表的可读名称（读屏用，如“Universe 范围过滤”） */
  label: string;
  /** 已提交的片段（规整后的标签，如 `0-3`、`10`） */
  tokens: string[];
  onChange: (tokens: string[]) => void;
  placeholder?: string;
  /** 常驻说明文字的元素 id（与错误文字一起作为 `aria-describedby`） */
  hintId?: string;
  disabled?: boolean;
}

/** 当前输入里无法识别的片段与原因。 */
interface TokenError {
  pieces: string[];
  reason: "syntax" | "outOfRange";
}

/**
 * Universe 片段输入（Token / Chip 形式）。
 *
 * - 回车、逗号、空格或失去焦点时把输入提交为片段；粘贴 `0-3, 10` 会自动拆成多个片段；
 * - 输入框为空时按退格删除最后一个片段；每个片段都有带名称的删除按钮；
 * - 无法识别或超出范围的部分留在输入框里，当场用图标 + 文字说明原因（不只靠颜色），
 *   并通过 `aria-invalid` / `aria-describedby` 告知读屏；
 * - 重复的片段自动合并。
 */
export function UniverseTokenInput({
  id,
  label,
  tokens,
  onChange,
  placeholder,
  hintId,
  disabled = false,
}: UniverseTokenInputProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<TokenError | null>(null);
  // 失去焦点提交与随后的删除点击发生在同一次渲染之前，用 ref 拿到最新的片段，避免互相覆盖
  const latest = useRef(tokens);
  useEffect(() => {
    latest.current = tokens;
  }, [tokens]);

  const emit = (next: string[]) => {
    latest.current = next;
    onChange(next);
  };

  /** 把一段文本提交为片段；无法识别的部分留在输入框里。 */
  const commit = (text: string) => {
    const pieces = splitUniverseInput(text);
    if (pieces.length === 0) {
      setDraft("");
      setError(null);
      return;
    }
    const base = latest.current;
    const next = [...base];
    const bad: string[] = [];
    let reason: TokenError["reason"] = "syntax";
    for (const piece of pieces) {
      const r = parseUniverseToken(piece);
      if (r.ok) {
        if (!next.includes(r.label)) next.push(r.label);
      } else {
        bad.push(piece);
        if (r.reason === "outOfRange") reason = "outOfRange";
      }
    }
    if (next.length !== base.length) emit(next);
    setDraft(bad.join(", "));
    setError(bad.length > 0 ? { pieces: bad, reason } : null);
  };

  const remove = (token: string) => {
    emit(latest.current.filter((x) => x !== token));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "，" || e.key === " ") {
      // 空输入时回车不拦截（让外层表单行为保持默认），其余分隔键一律视为提交
      if (e.key === "Enter" && draft.trim() === "") return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && tokens.length > 0) {
      e.preventDefault();
      emit(tokens.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
  };

  const describedBy = [hintId, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="grid gap-1.5">
      <div
        data-invalid={error ? "true" : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex min-h-11 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-surface-1 px-2 py-1.5",
          "shadow-[inset_0_1px_2px_0_rgb(0_0_0/0.10)] transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
          "hover:border-ring/50",
          "has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/25",
          "data-[invalid=true]:border-destructive data-[invalid=true]:ring-[3px] data-[invalid=true]:ring-destructive/20",
          disabled && "cursor-not-allowed bg-muted opacity-60 shadow-none hover:border-input",
        )}
      >
        {tokens.length > 0 && (
          <ul className="contents" aria-label={label}>
            {tokens.map((tok) => (
              <li
                key={tok}
                className="num inline-flex h-7 items-center gap-0.5 rounded-md border border-border bg-surface-3 pr-0.5 pl-2 text-xs font-medium"
              >
                {tok}
                {!disabled && (
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("recording.tokenRemove", { token: tok })}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(tok);
                    }}
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          id={id}
          className="num h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed"
          value={draft}
          disabled={disabled}
          placeholder={tokens.length === 0 ? placeholder : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(draft)}
        />
      </div>
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-xs text-destructive">
          <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t(error.reason === "outOfRange" ? "recording.tokenOutOfRange" : "recording.tokenInvalid", {
            list: error.pieces.join(", "),
          })}
        </p>
      )}
    </div>
  );
}
