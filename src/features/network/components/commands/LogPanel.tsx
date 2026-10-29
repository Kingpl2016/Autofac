import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { copyText } from "@/shared/lib/clipboard";
import { saveTextFile } from "@/shared/tauri/files";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevLogs } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { filterLogLines, isNearBottom, lineLevel } from "../../lib/logs";
import { netKeys } from "../../lib/queryKeys";
import type { NetDevice } from "../../lib/types";

/** 自动刷新间隔（毫秒）。 */
const LOG_POLL_MS = 3000;

const LEVEL_CLASS = {
  error: "text-destructive",
  warn: "text-warning",
  info: "text-foreground",
  debug: "text-muted-foreground",
} as const;

const LEVEL_TAG = { error: "E", warn: "W", info: "I", debug: "D" } as const;

interface LogPanelProps {
  device: NetDevice;
  access: DeviceAccess;
  /** 日志分段当前是否可见 */
  active: boolean;
}

/**
 * 设备日志：等宽文本，关键字过滤、自动刷新、复制与另存为。
 * 停在底部时自动跟随新日志；手动上滚后暂停跟随，并出现"回到底部"。
 */
export function LogPanel({ device, access, active }: LogPanelProps) {
  const { t } = useTranslation();
  const [auto, setAuto] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [pinned, setPinned] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: netKeys.logs(device.id),
    queryFn: () => netdevLogs(device.id),
    enabled: active && access.canRead,
    refetchInterval: auto ? LOG_POLL_MS : false,
    retry: false,
  });

  const lines = filterLogLines(query.data ?? "", keyword);

  // 新日志到来且用户停在底部时，滚到最底
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [lines.length, pinned]);

  const onScroll = () => {
    const el = box.current;
    if (el) setPinned(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  };

  const copy = () => copyText(lines.join("\n"), { success: t("network.logs.copied"), failure: t("network.logs.copyFailed") });

  const saveAs = async () => {
    try {
      const ok = await saveTextFile(`${device.name}.log`, lines.join("\n"), [{ name: "Log", extensions: ["log", "txt"] }]);
      if (ok) toast.success(t("network.logs.saved"));
    } catch (e) {
      toast.error(errorText(t, e));
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface-2 panel-edge">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Input
          type="search"
          role="searchbox"
          className="h-10 max-w-xs"
          value={keyword}
          placeholder={t("network.logs.filter")}
          aria-label={t("network.logs.filter")}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Switch id="net-log-auto" checked={auto} onCheckedChange={setAuto} />
          <Label htmlFor="net-log-auto" className="text-xs">
            {t("network.logs.auto")}
          </Label>
        </div>
        <span className="tabular text-xs text-muted-foreground" role="status">
          {t("network.logs.count", { count: lines.length })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={cn(query.isFetching && "animate-spin motion-reduce:animate-none")} />
            {t("network.files.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void copy()} disabled={lines.length === 0}>
            <Copy />
            {t("common.copy")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void saveAs()} disabled={lines.length === 0}>
            <Download />
            {t("network.logs.save")}
          </Button>
        </div>
      </header>

      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-label={t("network.logs.title")}
          tabIndex={0}
          /* 高度随窗口伸缩：矮窗口至少 16rem，高窗口最多 40rem */
          className="h-[clamp(16rem,50dvh,40rem)] overflow-auto bg-surface-1 px-4 py-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {query.isLoading ? (
            <p className="text-muted-foreground">{t("common.loading")}</p>
          ) : query.error ? (
            <p className="text-destructive">{errorText(t, query.error)}</p>
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground">{keyword ? t("network.logs.noMatch") : t("network.logs.empty")}</p>
          ) : (
            lines.map((line, i) => {
              const level = lineLevel(line);
              return (
                // 日志行没有稳定 id，且只追加 / 整体替换，用序号作 key 是安全的
                <div key={i} className={cn("whitespace-pre-wrap break-all", LEVEL_CLASS[level])}>
                  {/* 级别：视觉上是单字母，读屏读完整的级别名（span 上的 aria-label 不一定被朗读） */}
                  <span className="mr-2 inline-block w-3 select-none font-semibold opacity-80" aria-hidden>
                    {LEVEL_TAG[level]}
                  </span>
                  <span className="sr-only">{t(`network.logs.level.${level}`)}：</span>
                  {line}
                </div>
              );
            })
          )}
        </div>
        {!pinned && lines.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-3 right-5 shadow-lg"
            onClick={() => {
              setPinned(true);
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <ArrowDownToLine />
            {t("network.logs.toBottom")}
          </Button>
        )}
      </div>
    </section>
  );
}
