import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { NetDevice } from "../../lib/types";
import { BoardOpsPanel } from "./BoardOpsPanel";
import { PlayerPanel } from "./PlayerPanel";
import { ProgramQuickPick } from "./ProgramQuickPick";
import { WorkModePanel } from "./WorkModePanel";

interface ControlPanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 播放控制。宽屏两列：左列“正在发生什么”（播放器 + 节目快选），右列“设备怎么工作”（工作模式 + 设备操作）。
 */
export function ControlPanel({ device, access }: ControlPanelProps) {
  return (
    <div className="grid items-start gap-(--density-gutter) xl:grid-cols-2">
      <div className="grid gap-(--density-gutter)">
        <PlayerPanel device={device} access={access} />
        <ProgramQuickPick device={device} access={access} />
      </div>
      <div className="grid gap-(--density-gutter)">
        <WorkModePanel device={device} access={access} />
        <BoardOpsPanel device={device} access={access} />
      </div>
    </div>
  );
}
