import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Pencil, Check, X, Copy } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Device, DeviceCategory } from "@/shared/domain/device";
import { formatLastSeen } from "../lib/format";

const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  artNet: "Art-Net",
  sacn: "sACN",
  cluster: "Cluster",
  computer: "Computer",
  network: "Network",
};

interface DeviceRowProps {
  device: Device;
  /** 当前逻辑时间（毫秒），与 `device.lastSeenMs` 同一基准 */
  nowMs: number;
  onRename: (ip: string, name: string) => void;
}

/**
 * 设备表格单行：状态点、IP（可复制）、主机名（可编辑自定义名）、MAC、类别、
 * Art-Net 信息、最后在线时间。
 */
export function DeviceRow({ device, nowMs, onRename }: DeviceRowProps) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.customName ?? "");

  const displayName = device.customName || device.hostname || "—";

  const commit = () => {
    onRename(device.ip, draft.trim());
    setEditing(false);
  };

  const copyIp = () => {
    void navigator.clipboard
      ?.writeText(device.ip)
      .then(() => toast.success(t("discovery.copied", { value: device.ip })))
      .catch(() => undefined);
  };

  return (
    <div className="grid grid-cols-[5rem_8rem_1fr_9rem_6rem_6rem_7rem] items-center gap-x-5 py-5 text-sm">
      <span
        className={cn(
          "flex items-center gap-1.5",
          device.online ? "text-success" : "text-muted-foreground",
        )}
      >
        <Circle className="size-2 fill-current" aria-hidden />
        {device.online ? t("discovery.online") : t("discovery.offline")}
      </span>

      <span className="group flex min-w-0 items-center gap-1">
        <span className="tabular truncate">{device.ip}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("discovery.copyIp")}
          title={t("discovery.copyIp")}
          onClick={copyIp}
        >
          <Copy className="size-3.5" />
        </Button>
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        {editing ? (
          <>
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-7"
              placeholder={t("discovery.customNamePlaceholder")}
            />
            <Button variant="ghost" size="icon" className="size-7" onClick={commit}>
              <Check />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setEditing(false)}
            >
              <X />
            </Button>
          </>
        ) : (
          <>
            <span className="truncate">{displayName}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t("discovery.editName")}
              onClick={() => {
                setDraft(device.customName ?? "");
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          </>
        )}
      </span>

      <span className="tabular truncate text-muted-foreground">
        {device.mac ?? "—"}
      </span>

      <span>
        <Badge variant={device.category === "artNet" ? "default" : "secondary"}>
          {CATEGORY_LABEL[device.category]}
        </Badge>
      </span>

      <span className="tabular text-right text-muted-foreground">
        {device.artnetPorts != null
          ? `${device.artnetPorts} ${t("discovery.ports")}`
          : "—"}
      </span>

      <span className="truncate text-right text-muted-foreground">
        {formatLastSeen(device.lastSeenMs, nowMs, i18n.language)}
      </span>
    </div>
  );
}
