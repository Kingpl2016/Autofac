import { Activity, ScrollText, Settings2, SlidersHorizontal } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Segmented } from "@/shared/components/Segmented";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { parseSub, type CommandsSub } from "../../lib/tabs";
import type { NetDevice } from "../../lib/types";
import { ConfigPanel } from "./ConfigPanel";
import { ControlPanel } from "./ControlPanel";
import { DiagPanel } from "./DiagPanel";
import { LogPanel } from "./LogPanel";

interface CommandsTabProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 指令操作：控制 / 配置 / 诊断 / 日志四个子分段。
 * 只挂载当前分段，所以诊断和日志的轮询在切走后立即停止。分段存在 URL 的 `sub` 参数里，可分享、可回退。
 */
export function CommandsTab({ device, access }: CommandsTabProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const sub = parseSub(params.get("sub"));

  const change = (next: CommandsSub) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        if (next === "control") q.delete("sub");
        else q.set("sub", next);
        return q;
      },
      { replace: true },
    );

  const icon = "size-3.5";
  return (
    <div className="grid gap-(--density-gutter)">
      <Segmented
        ariaLabel={t("network.commands.sections")}
        size="md"
        value={sub}
        onChange={change}
        options={[
          { value: "control", label: t("network.commands.control"), icon: <SlidersHorizontal className={icon} aria-hidden /> },
          { value: "config", label: t("network.commands.config"), icon: <Settings2 className={icon} aria-hidden /> },
          { value: "diag", label: t("network.commands.diag"), icon: <Activity className={icon} aria-hidden /> },
          { value: "logs", label: t("network.commands.logs"), icon: <ScrollText className={icon} aria-hidden /> },
        ]}
        className="w-fit"
      />
      {sub === "control" && <ControlPanel device={device} access={access} />}
      {sub === "config" && <ConfigPanel device={device} access={access} />}
      {sub === "diag" && <DiagPanel device={device} access={access} active />}
      {sub === "logs" && <LogPanel device={device} access={access} active />}
    </div>
  );
}
