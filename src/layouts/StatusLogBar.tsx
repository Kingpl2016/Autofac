import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ChevronDown, ChevronUp, GripHorizontal, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LogList } from "@/shared/components/LogList";
import { ResizeSeparator } from "@/shared/components/ResizeSeparator";
import { useLogStore } from "@/shared/stores/logStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { UptimeBadge } from "./UptimeBadge";

/** 日志面板的最小高度（像素）。 */
const MIN_HEIGHT = 120;
/** 日志面板的默认高度（像素）。 */
const DEFAULT_HEIGHT = 176;
/** 日志面板最高占窗口高度的比例。 */
const MAX_HEIGHT_RATIO = 0.7;
/** 方向键每次调整的高度（像素）。 */
const KEY_STEP = 24;

/** 当前窗口下允许的最大面板高度。 */
const maxHeight = () => Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
const clampHeight = (h: number) => Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(h)));

/**
 * 底部状态条：左侧是可折叠的系统日志，右侧依次是“清空”、包速率和引擎运行时长。
 * 展开的日志面板可以拖动顶边向上拉伸（也可用方向键微调，双击恢复默认高度）。
 */
export function StatusLogBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const packetRate = useEngineStatusStore((s) => s.packetRate);

  return (
    <div data-layout="status-bar" className="shrink-0 border-t border-border bg-card">
      {open && (
        // 拖动把手：压在面板顶边上，热区比视觉上的细线更宽，方便抓取
        <ResizeSeparator
          orientation="horizontal"
          value={height}
          min={MIN_HEIGHT}
          max={maxHeight()}
          label={t("statusBar.resizeLog")}
          title={t("statusBar.resizeLog")}
          step={KEY_STEP}
          increaseKey="ArrowUp"
          // 保持原有习惯：Home 到最高、End 到最矮
          homeTo="max"
          // 向上拖 = 鼠标 y 变小 = 面板变高
          dragValue={(start, p) => start.value + (start.y - p.clientY)}
          normalize={clampHeight}
          onCommit={setHeight}
          defaultValue={DEFAULT_HEIGHT}
          onDraggingChange={setResizing}
          className={cn(
            "group relative z-10 -mb-px flex h-2 cursor-row-resize touch-none items-center justify-center",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            resizing ? "bg-primary/20" : "hover:bg-primary/10",
          )}
        >
          <GripHorizontal
            className={cn(
              "size-4 text-muted-foreground transition-opacity motion-reduce:transition-none",
              resizing ? "opacity-100" : "opacity-40 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
            aria-hidden
          />
        </ResizeSeparator>
      )}

      {open && (
        <div
          style={{ height }}
          className="overflow-y-auto border-b border-border bg-surface-1/40 px-6 py-2"
        >
          <LogList entries={entries} className="min-h-full" />
        </div>
      )}

      <div className="flex h-10 items-center justify-between px-8 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
        >
          <Terminal className="size-3.5" aria-hidden />
          <span className="font-medium">{t("statusBar.systemLog")}</span>
          {entries.length > 0 && (
            <span className="tabular rounded-full bg-surface-3 px-1.5 py-px text-[0.6875rem] leading-4 text-foreground">
              {entries.length}
            </span>
          )}
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronUp className="size-3.5" aria-hidden />
          )}
        </button>

        <div className="flex items-center gap-3 text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={clear}
            disabled={entries.length === 0}
            aria-label={t("statusBar.clear")}
          >
            <Trash2 className="size-3.5" />
            {t("statusBar.clear")}
          </Button>
          <span className="tabular flex items-center gap-1.5">
            <Activity className="size-3.5" aria-hidden />
            {t("statusBar.packetRate")}: {packetRate} {t("dashboard.packetsPerSec")}
          </span>
          <UptimeBadge />
        </div>
      </div>

    </div>
  );
}
