import { Pencil, Play, Plus, Radar, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Device } from "@/shared/domain/device";
import { useDeviceStatus } from "../hooks/useDeviceStatus";
import { useDeviceSessionStore } from "../stores/useDeviceSessionStore";
import { draftFromDiscovered } from "../lib/discovery";
import { PlayState, type NetDevice } from "../lib/types";
import type { DeviceDraft } from "./DeviceFormDialog";
import type { LinkState } from "../lib/access";
import { DeviceStatusBadge } from "./DeviceStatusBadge";

interface DeviceRailProps {
  devices: NetDevice[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (draft?: DeviceDraft) => void;
  onEdit: (device: NetDevice) => void;
  onRemove: (device: NetDevice) => void;
  /** 设备发现页里的 Art-Net 节点（已排除已保存的）。 */
  candidates: Device[];
}

/**
 * 左侧设备栏：已保存设备（状态 / 版本 / 播放中）、添加入口、设备发现候选。
 */
export function DeviceRail({ devices, activeId, onSelect, onAdd, onEdit, onRemove, candidates }: DeviceRailProps) {
  const { t } = useTranslation();
  return (
    <aside aria-label={t("network.rail.title")} className="flex flex-col gap-4">
      <section className="rounded-xl border border-border bg-surface-2 p-3 panel-edge">
        <header className="mb-2 flex items-center justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold tracking-tight">{t("network.rail.title")}</h2>
          <Button variant="ghost" size="sm" onClick={() => onAdd()} aria-label={t("network.rail.add")}>
            <Plus />
            {t("network.rail.add")}
          </Button>
        </header>

        {devices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">{t("network.rail.empty")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("network.rail.emptyHint")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                selected={d.id === activeId}
                onSelect={() => onSelect(d.id)}
                onEdit={() => onEdit(d)}
                onRemove={() => onRemove(d)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface-2 p-3 panel-edge">
        <header className="mb-1 flex items-center gap-2 px-1">
          <Radar className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">{t("network.rail.discovered")}</h2>
        </header>
        <p className="mb-2 px-1 text-xs text-muted-foreground">{t("network.rail.discoveredHint")}</p>
        {candidates.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("network.rail.discoveredEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {candidates.slice(0, 6).map((c) => (
              <li key={c.ip} className="flex items-center justify-between gap-2 rounded-md px-1 py-1">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{draftFromDiscovered(c).name}</span>
                  <span className="tabular block text-xs text-muted-foreground">{c.ip}</span>
                </span>
                <Button variant="outline" size="sm" onClick={() => onAdd(draftFromDiscovered(c))}>
                  {t("common.add")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

interface DeviceRowProps {
  device: NetDevice;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function DeviceRow({ device, selected, onSelect, onEdit, onRemove }: DeviceRowProps) {
  const { t } = useTranslation();
  const rebooting = useDeviceSessionStore((s) => device.id in s.rebooting);
  const { status, online, error, isLoading } = useDeviceStatus(device.id, rebooting);

  const link: LinkState = rebooting
    ? "rebooting"
    : online
      ? "online"
      : error?.code === "unauthorized"
        ? "needToken"
        : isLoading
          ? "checking"
          : "offline";
  const playing = online && status?.player.state === PlayState.Playing;

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 pr-20 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected
            ? "border-primary/50 bg-surface-3 glow-primary"
            : "border-transparent hover:bg-surface-3/60",
        )}
      >
        <span className="truncate text-sm font-medium">{device.name}</span>
        <span className="tabular truncate text-xs text-muted-foreground">
          {device.host}
          {device.port !== 80 ? `:${device.port}` : ""}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <DeviceStatusBadge state={link} />
          {online && status && (
            <span className="tabular text-xs text-muted-foreground">
              {t("network.rail.version", { version: status.version })}
            </span>
          )}
          {playing && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <Play className="size-3 fill-current" aria-hidden />
              {t("network.rail.playing")}
              {status && status.player.programNo > 0 ? ` · #${status.player.programNo}` : ""}
            </span>
          )}
        </span>
      </button>
      <div className="absolute right-1.5 top-1.5 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          aria-label={`${t("network.rail.edit")}: ${device.name}`}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          aria-label={`${t("network.rail.remove")}: ${device.name}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
