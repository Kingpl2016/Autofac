import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLogStore, type LogLevel } from "@/shared/stores/logStore";

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/**
 * 系统日志卡：显示 INFO/WARN/ERROR 日志并支持清空。
 */
export function SystemLogCard() {
  const { t } = useTranslation();
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between p-5 pb-3">
        <CardTitle className="text-base">{t("dashboard.systemLog")}</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={entries.length === 0}
        >
          <Trash2 />
          {t("statusBar.clear")}
        </Button>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-5 pb-5">
        <div className="h-48 overflow-y-auto font-mono text-xs">
          {entries.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">—</div>
          ) : (
            entries
              .slice()
              .reverse()
              .map((e) => (
                <div key={e.id} className="flex gap-2 py-0.5">
                  <span className="tabular text-muted-foreground">
                    {new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span
                    className={cn("w-10 shrink-0 uppercase", LEVEL_STYLE[e.level])}
                  >
                    {e.level}
                  </span>
                  <span>{e.message}</span>
                </div>
              ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
