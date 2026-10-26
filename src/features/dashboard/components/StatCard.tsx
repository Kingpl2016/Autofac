import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  /** 指标标题 */
  label: string;
  /** 指标值（已格式化） */
  value: string;
  /** 单位（可选），以较小字号紧跟数值 */
  unit?: string;
  /** 补充说明（可选），显示在数值下方，如“共 12 台” */
  hint?: string;
  /** 图标 */
  icon: LucideIcon;
}

/**
 * 仪表盘统计卡：标题 + 大号等宽数值 + 图标。
 */
export function StatCard({ label, value, unit, hint, icon: Icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="tabular mt-0.5 text-2xl font-semibold">
            {value}
            {unit ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {unit}
              </span>
            ) : null}
          </div>
          {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
        </div>
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </CardContent>
    </Card>
  );
}
