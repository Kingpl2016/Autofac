import { useEffect, useId, useState } from "react";

import { Label } from "@/components/ui/label";
import { CommitInput } from "./CommitInput";

interface SliderFieldProps {
  label: string;
  /** 数字框的无障碍名称（与滑杆区分开） */
  numberLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 数字框显示的小数位数，默认 0（取整显示）。 */
  decimals?: number;
  /** 数字框后的单位文字，例如 `%` / `ms` */
  unit?: string;
  /** 多个对象的值不一致时提示“混合值” */
  mixed?: boolean;
  mixedLabel?: string;
  /**
   * 提交新值：松开滑杆（或键盘调整完）、或数字框失焦 / Enter 时调用一次。
   *
   * @param value 新值。
   */
  onCommit: (value: number) => void;
}

/**
 * 滑杆 + 数字框的组合字段。
 *
 * 拖动滑杆时只改本地草稿（实时显示），松开才提交，这样一次拖动对应一步撤销。
 */
export function SliderField({
  label,
  numberLabel,
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
  mixed,
  mixedLabel,
  onCommit,
}: SliderFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;

  // 松开指针可能发生在滑杆之外，所以在窗口上监听
  useEffect(() => {
    if (draft === null) return;
    const finish = () => {
      onCommit(draft);
      setDraft(null);
    };
    window.addEventListener("pointerup", finish, { once: true });
    return () => window.removeEventListener("pointerup", finish);
  }, [draft, onCommit]);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {label}
          {mixed && <span className="ml-1.5 text-muted-foreground">{mixedLabel}</span>}
        </Label>
        <span className="flex items-center gap-1">
          <CommitInput
            className="num h-7 w-20 px-2 text-right text-xs"
            inputMode="numeric"
            label={numberLabel}
            value={Number(shown.toFixed(decimals))}
            onCommit={(text) => {
              const n = Number(text);
              if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
            }}
          />
          {unit && <span className="w-6 text-xs text-muted-foreground">{unit}</span>}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        className="w-full accent-primary"
        onChange={(e) => setDraft(Number(e.target.value))}
        // 键盘调整没有“松开指针”，抬起按键时提交
        onKeyUp={() => {
          if (draft !== null) {
            onCommit(draft);
            setDraft(null);
          }
        }}
      />
    </div>
  );
}
