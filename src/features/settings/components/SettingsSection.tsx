import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface SettingsSectionProps {
  /** 分区标题 */
  title: string;
  /** 分区内容（通常为若干 SettingRow） */
  children: ReactNode;
}

/**
 * 设置分区卡片，内部各行以分隔线隔开。
 */
export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Separator className="mb-2" />
        <div className="divide-y divide-border">{children}</div>
      </CardContent>
    </Card>
  );
}
