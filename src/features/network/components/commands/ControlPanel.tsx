import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { NetDevice } from "../../lib/types";
import { BoardOpsPanel } from "./BoardOpsPanel";
import { PlayerPanel } from "./PlayerPanel";
import { ProgramPanel } from "./ProgramPanel";
import { WorkModePanel } from "./WorkModePanel";

interface ControlPanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 控制：工作模式、播放器、节目操作、设备操作。
 * 宽屏两列：左列"决定做什么"（模式 + 节目），右列"正在发生什么"（播放器 + 设备操作）。
 */
export function ControlPanel({ device, access }: ControlPanelProps) {
  return (
    <div className="grid items-start gap-(--density-gutter) xl:grid-cols-2">
      <div className="grid gap-(--density-gutter)">
        <WorkModePanel device={device} access={access} />
        <ProgramPanel device={device} access={access} />
      </div>
      <div className="grid gap-(--density-gutter)">
        <PlayerPanel device={device} access={access} />
        <BoardOpsPanel device={device} access={access} />
      </div>
    </div>
  );
}
