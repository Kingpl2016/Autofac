import { useEffect } from "react";

import { onEvent } from "@/shared/tauri/events";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useOutputStore } from "@/shared/stores/outputStore";
import type {
  EngineStats,
  OutputPayload,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import type { Device } from "@/shared/domain/device";

/**
 * 订阅引擎事件（stats / universes / devices / output），更新全局 store。
 * 在应用根挂载一次。通道数据走二进制通道流，见 `useDmxStream`。
 */
export function useEngineListeners() {
  const setStats = useEngineDataStore((s) => s.setStats);
  const setUniverses = useEngineDataStore((s) => s.setUniverses);
  const setDevices = useEngineDataStore((s) => s.setDevices);
  const patchStatus = useEngineStatusStore((s) => s.patch);
  const setOutput = useOutputStore((s) => s.setOutput);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onEvent<EngineStats>("engine:stats", (p) => {
        setStats(p);
        patchStatus({
          connected: p.packetRate > 0 || p.activeUniverses > 0,
          packetRate: p.packetRate,
          uptimeSec: p.uptimeSec,
        });
      }),
      onEvent<UniverseSnapshot[]>("engine:universes", setUniverses),
      onEvent<Device[]>("discovery:devices", setDevices),
      onEvent<OutputPayload>("engine:output", setOutput),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStats, setUniverses, setDevices, patchStatus, setOutput]);
}
