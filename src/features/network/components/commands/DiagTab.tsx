import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { NetDevice } from "../../lib/types";
import { DiagPanel } from "./DiagPanel";
import { LogPanel } from "./LogPanel";

interface DiagTabProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 诊断与日志：上面是实时资源（堆、CPU、任务栈），下面是设备日志。
 * 只在 Tab 可见时挂载，切走后诊断与日志的轮询立即停止。
 */
export function DiagTab({ device, access }: DiagTabProps) {
  return (
    <div className="grid gap-(--density-gutter)">
      <DiagPanel device={device} access={access} active />
      <LogPanel device={device} access={access} active />
    </div>
  );
}
