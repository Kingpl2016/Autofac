import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Forward, Pencil, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Device, DeviceStyle } from "@/shared/domain/device";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { displayName } from "../lib/filters";
import { lastSeenAsClock } from "../lib/format";
import { formatUniverse } from "../lib/ports";
import { CategoryBadge } from "./CategoryBadge";
import { LastSeen } from "./LastSeen";
import { StatusIndicator } from "./StatusIndicator";

/** 设备样式 → 文案键。 */
const STYLE_KEYS: Record<DeviceStyle, string> = {
  node: "discovery.styleNode",
  controller: "discovery.styleController",
  media: "discovery.styleMedia",
  route: "discovery.styleRoute",
  backup: "discovery.styleBackup",
  config: "discovery.styleConfig",
  visual: "discovery.styleVisual",
};

interface DeviceDetailPanelProps {
  device: Device;
  /** 是否处于重命名状态（由外部控制，便于列表里按 F2 直接进入） */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  onRename: (ip: string, name: string) => void;
  onCopy: (value: string) => void;
  onAddToForwarding: (device: Device) => void;
  onClose: () => void;
}

/** 详情里的一行：标签 + 值（+ 可选复制按钮）。 */
function Field({
  label,
  children,
  copyValue,
  onCopy,
  copyLabel,
}: {
  label: string;
  children: ReactNode;
  copyValue?: string | null;
  onCopy?: (value: string) => void;
  copyLabel?: string;
}) {
  return (
    <>
      <dt className="py-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 py-1 text-sm">
        <span className="min-w-0 break-words">{children}</span>
        {copyValue && onCopy && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => onCopy(copyValue)}
          >
            <Copy className="size-3.5" />
          </Button>
        )}
      </dd>
    </>
  );
}

/**
 * 设备详情面板（并排、非模态）：不遮挡表格，可一边看详情一边对照其它行。
 * 包含身份信息、ArtPollReply 扩展字段、端口表、节点状态，以及重命名与“添加为转发目的地”。
 */
export function DeviceDetailPanel({
  device,
  renaming,
  onRenamingChange,
  onRename,
  onCopy,
  onAddToForwarding,
  onClose,
}: DeviceDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState(device.customName ?? "");
  const nowMs = useEngineDataStore((s) => s.stats.uptimeSec) * 1000;
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en";

  const name = displayName(device);
  const ports = device.ports ?? [];
  const lastSeenClock = lastSeenAsClock(device.lastSeenMs, nowMs);

  const startRename = () => {
    setDraft(device.customName ?? "");
    onRenamingChange(true);
  };
  const commit = () => {
    onRename(device.ip, draft.trim());
    onRenamingChange(false);
  };

  const handleNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      // 只取消重命名，不连带关闭面板
      e.stopPropagation();
      onRenamingChange(false);
    }
  };

  const handlePanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "F2" && !renaming) {
      e.preventDefault();
      startRename();
    }
  };

  return (
    <aside
      aria-label={t("discovery.panelTitle")}
      onKeyDown={handlePanelKey}
      className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <header className="flex items-start gap-2 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleNameKey}
                aria-label={t("discovery.customNamePlaceholder")}
                placeholder={t("discovery.customNamePlaceholder")}
                className="h-9"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label={t("discovery.saveName")}
                title={t("discovery.saveName")}
                onClick={commit}
              >
                <Check />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label={t("discovery.cancelEdit")}
                title={t("discovery.cancelEdit")}
                onClick={() => onRenamingChange(false)}
              >
                <X />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <h2 className="min-w-0 truncate text-base font-semibold" title={name}>
                {name}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label={t("discovery.rename")}
                aria-keyshortcuts="F2"
                title={`${t("discovery.rename")} (F2)`}
                onClick={startRename}
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusIndicator online={device.online} />
            <CategoryBadge category={device.category} />
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("discovery.closePanel")}
          title={t("discovery.closePanel")}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3">
          <Field
            label={t("discovery.fieldIp")}
            copyValue={device.ip}
            onCopy={onCopy}
            copyLabel={t("discovery.copyIp")}
          >
            <span className="tabular">{device.ip}</span>
          </Field>
          <Field
            label={t("discovery.fieldMac")}
            copyValue={device.mac}
            onCopy={onCopy}
            copyLabel={t("discovery.copyMac")}
          >
            <span className="tabular">{device.mac ?? "—"}</span>
          </Field>
          <Field label={t("discovery.fieldHostname")}>{device.hostname ?? "—"}</Field>
          <Field label={t("discovery.fieldShortName")}>{device.shortName ?? "—"}</Field>
          <Field label={t("discovery.fieldStyle")}>
            {device.style ? t(STYLE_KEYS[device.style]) : "—"}
          </Field>
          <Field label={t("discovery.fieldManufacturer")}>{device.manufacturer ?? "—"}</Field>
          <Field label={t("discovery.fieldOem")}>
            <span className="tabular">
              {device.oem ? `0x${device.oem.toString(16).toUpperCase().padStart(4, "0")}` : "—"}
            </span>
          </Field>
          <Field label={t("discovery.fieldFirmware")}>
            <span className="tabular">{device.firmware ?? "—"}</span>
          </Field>
          <Field label={t("discovery.fieldLastSeen")}>
            <span>
              <LastSeen lastSeenMs={device.lastSeenMs} />
              <span className="tabular block text-xs text-muted-foreground">
                {lastSeenClock.toLocaleTimeString(locale)}
              </span>
            </span>
          </Field>
        </dl>

        {device.nodeReport && (
          <section className="mt-4">
            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("discovery.fieldNodeReport")}
            </h3>
            <p className="tabular whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-xs">
              {device.nodeReport}
            </p>
          </section>
        )}

        <section className="mt-4">
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t("discovery.portsTitle")}
          </h3>
          {ports.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("discovery.noPorts")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {ports.map((p) => (
                <li
                  key={`${p.index}-${p.direction}`}
                  className="flex items-center gap-2 px-3 py-2 text-xs"
                >
                  <span className="w-12 shrink-0 text-muted-foreground">
                    {t("discovery.portLabel", { n: p.index + 1 })}
                  </span>
                  <Badge variant={p.direction === "input" ? "secondary" : "default"}>
                    {p.direction === "input"
                      ? t("discovery.portDirIn")
                      : t("discovery.portDirOut")}
                  </Badge>
                  <span className="tabular flex-1" title={`Port-Address ${p.universe}`}>
                    {formatUniverse(p.universe)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0",
                      p.active ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    {p.active ? t("discovery.portActive") : t("discovery.portIdle")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="border-t border-border p-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => onAddToForwarding(device)}
        >
          <Forward />
          {t("discovery.addToForwarding")}
        </Button>
      </footer>
    </aside>
  );
}
