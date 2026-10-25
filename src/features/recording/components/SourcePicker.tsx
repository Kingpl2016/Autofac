import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Device } from "@/shared/domain/device";
import { useProtocolFlags } from "@/features/settings";
import type { SourceStat } from "../lib/types";

interface SourcePickerProps {
  /** 当前检测到的来源 */
  sources: SourceStat[];
  /** 设备发现结果，用于显示设备名 */
  devices: Device[];
  /** 已勾选的来源 IP */
  selected: string[];
  /** 勾选 / 取消勾选 */
  onToggle: (ip: string) => void;
  /** 是否禁用（录制中不可更改） */
  disabled?: boolean;
}

/** 协议徽标文案。 */
function protocolLabel(p: SourceStat["protocol"]): string {
  if (p === "sacn") return "sACN";
  if (p === "artNet") return "Art-Net";
  return "—";
}

/**
 * 来源设备选择器：列出当前检测到的发送方（IP、设备名、协议、Universe 数、累计包数），
 * 勾选后用于按设备过滤录制。已勾选但暂时离线的来源仍会保留在列表中。
 */
export function SourcePicker({
  sources,
  devices,
  selected,
  onToggle,
  disabled = false,
}: SourcePickerProps) {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const names = new Map(
    devices.map((d) => [d.ip, d.customName || d.hostname || ""] as const),
  );

  // 已勾选但当前不再活跃的来源也要显示，避免用户看不到自己选了什么
  const live = new Set(sources.map((s) => s.ip));
  const rows: Array<SourceStat & { offline: boolean }> = [
    ...sources.map((s) => ({ ...s, offline: false })),
    ...selected
      .filter((ip) => !live.has(ip))
      .map((ip) => ({
        ip,
        protocol: null,
        universes: [],
        packets: 0,
        offline: true,
      })),
  ];

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t(sacnEnabled ? "recording.noSources" : "recording.noSourcesArtnetOnly")}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((s) => {
        const checked = selected.includes(s.ip);
        const name = names.get(s.ip);
        return (
          <li key={s.ip}>
            <label
              className={cn(
                "grid cursor-pointer grid-cols-[1.25rem_1fr_auto_auto_auto] items-center gap-x-4 px-3 py-2 text-sm",
                "hover:bg-accent/50",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(s.ip)}
              />
              <span className="min-w-0">
                <span className="tabular font-medium">{s.ip}</span>
                {name && (
                  <span className="ml-2 truncate text-muted-foreground">{name}</span>
                )}
              </span>
              <Badge variant={s.offline ? "outline" : "secondary"}>
                {s.offline ? t("recording.sourceOffline") : protocolLabel(s.protocol)}
              </Badge>
              <span className="tabular w-28 text-right text-xs text-muted-foreground">
                {t("recording.sourceUniverses", { n: s.universes.length })}
              </span>
              <span className="tabular w-24 text-right text-xs text-muted-foreground">
                {t("recording.sourcePackets", { n: s.packets })}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
