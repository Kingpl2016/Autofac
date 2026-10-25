import { cn } from "@/lib/utils";

interface MetricChipProps {
  label: string;
  value: string;
  /** 异常时用警告色（配合文字说明，不单靠颜色） */
  warn?: boolean;
  className?: string;
}

/**
 * 指标：左侧细竖线 + 弱化标签 + 大一号的数值。需放在 `<dl>` 内。
 * 不再用实心小方块，靠字号和留白分层。
 */
export function MetricChip({ label, value, warn = false, className }: MetricChipProps) {
  return (
    <div
      className={cn(
        "border-l-2 pl-3",
        warn ? "border-warning text-warning" : "border-border",
        className,
      )}
    >
      <dt className={cn("text-xs", warn ? "text-warning" : "text-muted-foreground")}>
        {label}
      </dt>
      <dd className="num mt-1 text-lg leading-none font-semibold">{value}</dd>
    </div>
  );
}
