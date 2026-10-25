import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Device } from "@/shared/domain/device";
import { displayName } from "../lib/filters";
import { summarizePorts } from "../lib/ports";
import { CategoryBadge } from "./CategoryBadge";
import { LastSeen } from "./LastSeen";
import { StatusIndicator } from "./StatusIndicator";

interface DeviceTableRowProps {
  device: Device;
  /** 是否为详情面板当前展示的设备 */
  selected: boolean;
  /** 是否刚被发现（短暂高亮 + “新”标记） */
  fresh: boolean;
  /** 漫游 tabindex：整张表只有一个行是 Tab 停靠点 */
  active: boolean;
  showMac: boolean;
  onToggle: (ip: string) => void;
  onActivate: (ip: string) => void;
  onCopy: (value: string) => void;
  /** 按 F2：打开该设备详情并进入重命名 */
  onRename: (ip: string) => void;
}

/** 端口列：优先“x 入 · y 出”，退回总数，再退回占位符。 */
function PortsCell({ device }: { device: Device }) {
  const { t } = useTranslation();
  const { input, output } = summarizePorts(device.ports);
  if (input + output > 0) {
    return <>{t("discovery.portsSummary", { input, output })}</>;
  }
  if (device.artnetPorts != null) {
    return <>{t("discovery.portsCount", { n: device.artnetPorts })}</>;
  }
  return <>—</>;
}

/**
 * 设备表格单行（紧凑单行 44px）。整行可点击 / 键盘激活以打开详情面板；
 * 行内只保留一个悬停或聚焦才出现的“复制 IP”，其余操作都在详情面板里，
 * 避免每行多个 Tab 停靠点。
 */
function DeviceTableRowImpl({
  device,
  selected,
  fresh,
  active,
  showMac,
  onToggle,
  onActivate,
  onCopy,
  onRename,
}: DeviceTableRowProps) {
  const { t } = useTranslation();
  const name = displayName(device);
  const unnamed = name === device.ip;

  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    // 只处理行本身的按键，行内按钮（复制）自己处理 Enter / Space
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(device.ip);
    } else if (e.key === "F2") {
      e.preventDefault();
      onRename(device.ip);
    } else if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey) {
      onCopy(device.ip);
    }
  };

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    onCopy(device.ip);
  };

  return (
    <tr
      data-ip={device.ip}
      tabIndex={active ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      aria-keyshortcuts="C F2"
      onClick={() => onToggle(device.ip)}
      onFocus={() => onActivate(device.ip)}
      onKeyDown={handleKeyDown}
      className={cn(
        "group h-11 cursor-pointer border-b border-border transition-colors duration-700 last:border-b-0",
        "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        fresh && "bg-primary/15",
        selected && "bg-primary/10 shadow-[inset_2px_0_0_0_var(--primary)]",
        !device.online && "text-muted-foreground",
      )}
    >
      <td className="max-w-0 px-4">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate",
              unnamed ? "tabular text-muted-foreground" : "font-medium",
            )}
            title={name}
          >
            {name}
          </span>
          {fresh && <Badge className="shrink-0">{t("discovery.newBadge")}</Badge>}
        </span>
      </td>

      <td className="px-4">
        <span className="flex items-center gap-1">
          <span className="tabular">{device.ip}</span>
          <Button
            variant="ghost"
            size="icon"
            tabIndex={-1}
            className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-label={t("discovery.copyIp")}
            title={t("discovery.copyIp")}
            onClick={handleCopy}
          >
            <Copy className="size-3.5" />
          </Button>
        </span>
      </td>

      <td className="px-4">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <StatusIndicator online={device.online} />
          <span className="text-xs text-muted-foreground">
            · <LastSeen lastSeenMs={device.lastSeenMs} />
          </span>
        </span>
      </td>

      <td className="px-4">
        <CategoryBadge category={device.category} />
      </td>

      <td className="tabular whitespace-nowrap px-4 text-muted-foreground">
        <PortsCell device={device} />
      </td>

      {showMac && (
        <td className="tabular whitespace-nowrap px-4 text-muted-foreground">
          {device.mac ?? "—"}
        </td>
      )}
    </tr>
  );
}

/**
 * 行级 memo：后端每次推送都会给出全新的设备对象，所以按内容而不是引用比较，
 * 只有该设备数据或选中 / 高亮状态真的变化才重渲。
 */
export const DeviceTableRow = memo(
  DeviceTableRowImpl,
  (prev, next) =>
    prev.selected === next.selected &&
    prev.fresh === next.fresh &&
    prev.active === next.active &&
    prev.showMac === next.showMac &&
    prev.onToggle === next.onToggle &&
    prev.onActivate === next.onActivate &&
    prev.onCopy === next.onCopy &&
    prev.onRename === next.onRename &&
    (prev.device === next.device ||
      JSON.stringify(prev.device) === JSON.stringify(next.device)),
);
