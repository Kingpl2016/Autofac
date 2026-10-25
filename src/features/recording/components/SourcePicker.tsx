import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

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
    <ul className="grid gap-2">
      {rows.map((s) => {
        const checked = selected.includes(s.ip);
        const name = names.get(s.ip);
        return (
          <li key={s.ip}>
            <label
              className={cn(
                "flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-2.5 text-sm transition-colors",
                "hover:bg-surface-3",
                "has-checked:border-primary/60 has-checked:bg-primary/10",
                "has-focus-visible:ring-2 has-focus-visible:ring-ring",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(s.ip)}
              />
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded border border-input text-primary-foreground peer-checked:border-primary peer-checked:bg-primary"
                aria-hidden
              >
                {checked && <Check className="size-3.5" />}
              </span>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  s.offline ? "bg-offline" : "bg-online",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="num block font-medium">{s.ip}</span>
                {name && (
                  <span className="block truncate text-xs text-muted-foreground">{name}</span>
                )}
              </span>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <span className="num text-xs text-muted-foreground">
                  {t("recording.sourceUniverses", { n: s.universes.length })} ·{" "}
                  {t("recording.sourcePackets", { n: s.packets })}
                </span>
                <Badge variant={s.offline ? "outline" : "secondary"}>
                  {s.offline ? t("recording.sourceOffline") : protocolLabel(s.protocol)}
                </Badge>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
