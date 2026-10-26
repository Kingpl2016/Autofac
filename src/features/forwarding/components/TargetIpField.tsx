import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { displayName } from "@/features/discovery/lib/filters";
import type { Device } from "@/shared/domain/device";
import { groupOnlineDevices } from "../lib/deviceOptions";

/** 下拉里“手动输入”项的占位值（不会与真实 IP 冲突）。 */
const MANUAL = "__manual__";

interface TargetIpFieldProps {
  /** 输入框 / 下拉触发器的 id，标签与错误提示据此关联。 */
  id: string;
  label: string;
  value: string;
  /** 内联错误文字（已本地化）；为空表示没有错误。 */
  error?: string;
  /** 已发现的设备；只用其中在线的。 */
  devices: readonly Device[];
  sacnEnabled: boolean;
  /** 手动输入时的 IP 变化。 */
  onManualChange: (ip: string) => void;
  /** 从列表选中一台设备。 */
  onPick: (device: Device) => void;
}

/**
 * 目标 IP：优先从在线设备列表（按 Art-Net / sACN / 其他分组）里选，
 * 也可以切到手动输入。当前 IP 不在在线设备里（例如手填的地址、已离线的设备）时默认进入手动输入。
 */
export function TargetIpField({
  id,
  label,
  value,
  error,
  devices,
  sacnEnabled,
  onManualChange,
  onPick,
}: TargetIpFieldProps) {
  const { t } = useTranslation();
  const groups = groupOnlineDevices(devices, { sacnEnabled });
  const online = groups.flatMap((g) => g.devices);
  const hasDevices = online.length > 0;
  const [manual, setManual] = useState(() => {
    const ip = value.trim();
    return ip === "" ? !hasDevices : !online.some((d) => d.ip === ip);
  });
  // 没有任何在线设备时只能手动输入
  const showManual = manual || !hasDevices;
  const aria = error ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hasDevices && (
          <button
            type="button"
            className="rounded text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setManual(!showManual)}
          >
            {showManual ? t("forwarding.pickFromList") : t("forwarding.enterManually")}
          </button>
        )}
      </div>

      {showManual ? (
        <Input
          id={id}
          className="tabular"
          placeholder="10.0.0.5"
          inputMode="decimal"
          value={value}
          onChange={(e) => onManualChange(e.target.value)}
          {...aria}
        />
      ) : (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            if (v === MANUAL) {
              setManual(true);
              return;
            }
            const device = online.find((d) => d.ip === v);
            if (device) onPick(device);
          }}
        >
          <SelectTrigger id={id} {...aria}>
            <SelectValue placeholder={t("forwarding.pickDevice")} />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.id}>
                <SelectLabel>{t(`forwarding.group.${g.id}`)}</SelectLabel>
                {g.devices.map((d) => (
                  <SelectItem key={d.ip} value={d.ip}>
                    <span>{displayName(d)}</span>
                    {displayName(d) !== d.ip && (
                      <span className="tabular ml-2 text-xs text-muted-foreground">{d.ip}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectGroup>
              <SelectItem value={MANUAL}>{t("forwarding.enterManuallyItem")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      )}

      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}