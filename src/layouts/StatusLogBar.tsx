import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, ChevronUp, ChevronDown, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLogStore, type LogLevel } from "@/shared/stores/logStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/** 按当前界面语言格式化日志时间。 */
function formatTime(ts: number, language: string): string {
  const locale = language.startsWith("zh") ? "zh-CN" : "en-US";
  return new Date(ts).toLocaleTimeString(locale, { hour12: false });
}

/**
 * 底部状态条：可折叠的系统日志 + 包速率 / 运行时长概览。
 */
export function StatusLogBar() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const packetRate = useEngineStatusStore((s) => s.packetRate);
  const uptimeSec = useEngineStatusStore((s) => s.uptimeSec);

  return (
    <div className="shrink-0 border-t border-border bg-card">
      <div className="flex h-10 items-center justify-between px-8 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-expanded={open}
        >
          <Terminal className="size-3.5" aria-hidden />
          <span>{t("statusBar.systemLog")}</span>
          {entries.length > 0 && (
            <span className="tabular text-foreground">({entries.length})</span>
          )}
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronUp className="size-3.5" aria-hidden />
          )}
        </button>

        <div className="flex items-center gap-4 text-muted-foreground">
          <span className="tabular">
            {t("statusBar.packetRate")}: {packetRate} {t("dashboard.packetsPerSec")}
          </span>
          <span className="tabular">
            {t("statusBar.uptime")}: {uptimeSec}s
          </span>
        </div>
      </div>

      {open && (
        <div className="flex h-40 flex-col border-t border-border">
          <div className="flex items-center justify-end px-8 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={entries.length === 0}
            >
              <Trash2 />
              {t("statusBar.clear")}
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-8 pb-3 font-mono text-xs">
            {entries.length === 0 ? (
              <div className="py-4 text-center text-muted-foreground">—</div>
            ) : (
              entries
                .slice()
                .reverse()
                .map((e) => (
                  <div key={e.id} className="flex gap-3 py-1">
                    <span className="tabular text-muted-foreground">
                      {formatTime(e.ts, i18n.language)}
                    </span>
                    <span
                      className={cn(
                        "w-10 shrink-0 uppercase",
                        LEVEL_STYLE[e.level],
                      )}
                    >
                      {e.level}
                    </span>
                    <span className="text-foreground">{e.message}</span>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
