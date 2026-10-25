import { useEffect } from "react";

import { onEvent } from "@/shared/tauri/events";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import type {
  ChannelsPayload,
  EngineStats,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import type { Device } from "@/shared/domain/device";

/**
 * 订阅引擎事件（stats / universes / channels），更新全局 store。
 * 在应用根挂载一次。
 */
export function useEngineListeners() {
  const setStats = useEngineDataStore((s) => s.setStats);
  const setUniverses = useEngineDataStore((s) => s.setUniverses);
  const setChannels = useEngineDataStore((s) => s.setChannels);
  const setDevices = useEngineDataStore((s) => s.setDevices);
  const patchStatus = useEngineStatusStore((s) => s.patch);

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
      onEvent<ChannelsPayload>("engine:channels", (p) =>
        setChannels(p.universe, p.data),
      ),
      onEvent<Device[]>("discovery:devices", setDevices),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStats, setUniverses, setChannels, setDevices, patchStatus]);
}
