import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProtocolFlags } from "@/features/settings";
import { isUnspecifiedIpv4, isValidIpv4 } from "@/shared/lib/ip";
import type { PlayerTarget } from "../lib/types";

interface PlayerTargetPickerProps {
  /** 当前生效的输出目标 */
  target: PlayerTarget;
  /** 启用的转发目的地数量 */
  destinations: number;
  /** 应用新的输出目标 */
  onApply: (target: PlayerTarget) => void;
}


const DEFAULT_PORT = { artNet: 6454, sacn: 5568 } as const;

/**
 * 回放输出目标选择：沿用转发表，或直接发往指定设备（IP / 协议 / 端口）。
 */
export function PlayerTargetPicker({
  target,
  destinations,
  onApply,
}: PlayerTargetPickerProps) {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const direct = target.kind === "direct" ? target : null;
  // sACN 关闭时，已有的 sACN 直发目标不能沿用其协议与端口，回落到 Art-Net 默认值
  const keepDirect = direct !== null && (sacnEnabled || direct.protocol !== "sacn");
  const [kind, setKind] = useState<PlayerTarget["kind"]>(target.kind);
  const [ip, setIp] = useState(direct?.ip ?? "");
  const [protocol, setProtocol] = useState<"artNet" | "sacn">(
    keepDirect ? direct.protocol : "artNet",
  );
  const [port, setPort] = useState(
    String(keepDirect ? direct.port : DEFAULT_PORT.artNet),
  );
  // 关闭 sACN 后即使本地状态仍是 sacn，也只会按 Art-Net 应用
  const effectiveProtocol = sacnEnabled ? protocol : "artNet";

  // 0.0.0.0 只能用于绑定，不能作为发送目标（系统会拒绝发送）
  const ipUnspecified = isUnspecifiedIpv4(ip);
  const ipOk = isValidIpv4(ip) && !ipUnspecified;
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;

  const apply = () => {
    if (kind === "forwarding") {
      onApply({ kind: "forwarding" });
    } else if (ipOk && portOk) {
      onApply({ kind: "direct", ip: ip.trim(), protocol: effectiveProtocol, port: portNum });
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5 md:max-w-xs">
        <Label htmlFor="player-target-kind" className="text-xs font-medium text-muted-foreground">{t("player.target")}</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as PlayerTarget["kind"])}>
          <SelectTrigger id="player-target-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forwarding">{t("player.targetForwarding")}</SelectItem>
            <SelectItem value="direct">{t("player.targetDirect")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {kind === "direct" && (
        <div
          className={
            sacnEnabled
              ? "grid gap-3 md:grid-cols-[1fr_9rem_7rem]"
              : "grid gap-3 md:grid-cols-[1fr_7rem]"
          }
        >
          <div className="grid content-start gap-1.5">
            <Label htmlFor="player-target-ip" className="text-xs font-medium text-muted-foreground">{t("player.targetIp")}</Label>
            <Input
              id="player-target-ip"
              className="tabular"
              value={ip}
              placeholder="192.168.1.50"
              aria-invalid={ip.length > 0 && !ipOk}
              aria-describedby={ipUnspecified ? "player-target-ip-error" : undefined}
              onChange={(e) => setIp(e.target.value)}
            />
            {ipUnspecified && (
              <p id="player-target-ip-error" className="text-xs text-destructive">
                {t("player.ipUnspecified")}
              </p>
            )}
          </div>
          {sacnEnabled && (
            <div className="grid content-start gap-1.5">
              <Label htmlFor="player-target-proto" className="text-xs font-medium text-muted-foreground">{t("player.targetProtocol")}</Label>
              <Select
                value={protocol}
                onValueChange={(v) => {
                  const p = v as "artNet" | "sacn";
                  setProtocol(p);
                  setPort(String(DEFAULT_PORT[p]));
                }}
              >
                <SelectTrigger id="player-target-proto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="artNet">Art-Net</SelectItem>
                  <SelectItem value="sacn">sACN</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid content-start gap-1.5">
            <Label htmlFor="player-target-port" className="text-xs font-medium text-muted-foreground">{t("player.targetPort")}</Label>
            <Input
              id="player-target-port"
              type="number"
              className="tabular"
              value={port}
              aria-invalid={!portOk}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={apply}
          disabled={kind === "direct" && !(ipOk && portOk)}
        >
          {t("player.applyTarget")}
        </Button>
        {target.kind === "direct" ? (
          <span className="tabular text-xs text-muted-foreground">
            {t("player.currentDirect", {
              ip: target.ip,
              port: target.port,
            })}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("player.currentForwarding", { n: destinations })}
          </span>
        )}
      </div>

      {target.kind === "direct" && isUnspecifiedIpv4(target.ip) && (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("player.currentUnspecified")}
        </p>
      )}
      {target.kind === "forwarding" && destinations === 0 && (
        <p className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("player.noDestinations")}
        </p>
      )}
    </div>
  );
}
