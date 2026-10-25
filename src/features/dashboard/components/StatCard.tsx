import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  /** 指标标题 */
  label: string;
  /** 指标值（已格式化） */
  value: string;
  /** 图标 */
  icon: LucideIcon;
}

/**
 * 仪表盘统计卡：标题 + 大号等宽数值 + 图标。
 */
export function StatCard({ label, value, icon: Icon }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="tabular mt-0.5 text-2xl font-semibold">{value}</div>
        </div>
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </CardContent>
    </Card>
  );
}
