import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

interface StepperProps {
  /** 各步骤标题 */
  steps: readonly string[];
  /** 当前步骤（从 0 起）；等于 `steps.length` 表示全部完成 */
  current: number;
  /** 无障碍名称 */
  label: string;
}

/**
 * 横向步骤指示器：已完成显示对勾，当前步骤高亮（`aria-current="step"`），后续步骤置灰。
 * 状态用图标 / 数字 / 文字表达，不只靠颜色。
 */
export function Stepper({ steps, current, label }: StepperProps) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((title, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={title} aria-current={active ? "step" : undefined} className="flex items-center gap-2">
            <span
              className={cn(
                "tabular flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                done && "bg-success/20 text-success",
                active && "bg-primary text-primary-foreground",
                !done && !active && "bg-surface-1 text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-sm", active ? "font-semibold" : done ? "text-foreground" : "text-muted-foreground")}>
              {title}
            </span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
