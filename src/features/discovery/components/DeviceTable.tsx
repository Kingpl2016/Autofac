import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Device } from "@/shared/domain/device";
import type { SortDir, SortKey } from "../lib/filters";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { DeviceTableRow } from "./DeviceTableRow";

/** 供父组件命令式聚焦某一行（如关闭详情面板后把焦点还给原行）。 */
export interface DeviceTableHandle {
  focusRow: (ip: string) => void;
}

interface DeviceTableProps {
  /** 已过滤并排序的设备 */
  devices: readonly Device[];
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  selectedIp: string | null;
  /** 选中设备；传 `null` 取消选中 */
  onSelect: (ip: string | null) => void;
  /** 刚被发现的设备 IP（短暂高亮） */
  freshIps: ReadonlySet<string>;
  showMac: boolean;
  /** 按 F2：选中该设备并进入重命名 */
  onRename: (ip: string) => void;
  ref?: Ref<DeviceTableHandle>;
}

interface Column {
  /** 对应的排序键；不可排序的列为 `null` */
  sortKey: SortKey | null;
  labelKey: string;
  className?: string;
}

const COLUMNS: Column[] = [
  // 名称列不设宽度：固定布局下吃掉其余空间，其余列用固定宽度
  { sortKey: "name", labelKey: "discovery.colName" },
  { sortKey: "ip", labelKey: "discovery.colIp", className: "w-36" },
  { sortKey: "status", labelKey: "discovery.colStatus", className: "w-52" },
  { sortKey: "category", labelKey: "discovery.colCategory", className: "w-32" },
  { sortKey: "ports", labelKey: "discovery.colPorts", className: "w-28" },
];
const MAC_COLUMN: Column = {
  sortKey: null,
  labelKey: "discovery.colMac",
  className: "w-44",
};

/**
 * 设备表格：固定表头、表头点击排序（`aria-sort`）、↑/↓ 在行间移动、
 * Enter / Space 打开详情、`C` 复制 IP、Esc 关闭详情。
 */
export function DeviceTable({
  devices,
  sort,
  onSort,
  selectedIp,
  onSelect,
  freshIps,
  showMac,
  onRename,
  ref,
}: DeviceTableProps) {
  const { t } = useTranslation();
  const copy = useCopyToClipboard();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [focusedIp, setFocusedIp] = useState<string | null>(null);

  // 漫游 tabindex 的落点：最近聚焦的行 > 选中行 > 第一行（都必须仍在列表里）
  const has = (ip: string | null) => ip != null && devices.some((d) => d.ip === ip);
  const activeIp = has(focusedIp) ? focusedIp : has(selectedIp) ? selectedIp : devices[0]?.ip;

  const rows = () =>
    Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-ip]") ?? []);

  useImperativeHandle(ref, () => ({
    focusRow: (ip) => {
      rows()
        .find((r) => r.dataset.ip === ip)
        ?.focus();
    },
  }));

  const handleToggle = useCallback(
    (ip: string) => onSelect(ip === selectedIp ? null : ip),
    [onSelect, selectedIp],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key === "Escape") {
      if (selectedIp) onSelect(null);
      return;
    }
    const list = rows();
    const idx = list.findIndex((r) => r === document.activeElement);
    if (idx < 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(idx + 1, list.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(idx - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  };

  const columns = showMac ? [...COLUMNS, MAC_COLUMN] : COLUMNS;

  return (
    <table aria-label={t("discovery.tableLabel")} className="w-full table-fixed text-sm">
      <thead>
        <tr>
          {columns.map((c) => {
            const sorted = c.sortKey != null && sort.key === c.sortKey;
            const colLabel = t(c.labelKey);
            return (
              <th
                key={c.labelKey}
                scope="col"
                aria-sort={
                  sorted ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                }
                className={cn(
                  "sticky top-0 z-10 h-10 border-b border-border bg-card px-4 text-left text-xs font-medium text-muted-foreground",
                  c.className,
                )}
              >
                {c.sortKey ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.sortKey as SortKey)}
                    aria-label={t("discovery.sortBy", { col: colLabel })}
                    className={cn(
                      "-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-accent-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      sorted && "text-foreground",
                    )}
                  >
                    {colLabel}
                    {sorted ? (
                      sort.dir === "asc" ? (
                        <ArrowUp className="size-3.5" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3.5" aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                    )}
                  </button>
                ) : (
                  colLabel
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody ref={bodyRef} onKeyDown={handleKeyDown}>
        {devices.map((d) => (
          <DeviceTableRow
            key={d.ip}
            device={d}
            selected={d.ip === selectedIp}
            fresh={freshIps.has(d.ip)}
            active={d.ip === activeIp}
            showMac={showMac}
            onToggle={handleToggle}
            onActivate={setFocusedIp}
            onCopy={copy}
            onRename={onRename}
          />
        ))}
      </tbody>
    </table>
  );
}
