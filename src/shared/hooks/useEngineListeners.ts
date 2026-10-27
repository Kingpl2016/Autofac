import { fromTauriEvent } from "@/shared/events/fromTauriEvent";
import { useSubscription } from "@/shared/events/useObservable";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useOutputStore } from "@/shared/stores/outputStore";
import type {
  EngineStats,
  OutputPayload,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import type { Device } from "@/shared/domain/device";

// 冷 Observable：订阅时才向后端 listen，退订时 unlisten；模块级常量保证引用稳定
const stats$ = fromTauriEvent<EngineStats>("engine:stats");
const universes$ = fromTauriEvent<UniverseSnapshot[]>("engine:universes");
const devices$ = fromTauriEvent<Device[]>("discovery:devices");
const output$ = fromTauriEvent<OutputPayload>("engine:output");

/**
 * 订阅引擎事件（stats / universes / devices / output），更新全局 store。
 * 由引擎插件的 `Runtime` 挂载一次。通道数据走二进制通道流，见 `useDmxStream`。
 */
export function useEngineListeners() {
  const setStats = useEngineDataStore((s) => s.setStats);
  const setUniverses = useEngineDataStore((s) => s.setUniverses);
  const setDevices = useEngineDataStore((s) => s.setDevices);
  const patchStatus = useEngineStatusStore((s) => s.patch);
  const setOutput = useOutputStore((s) => s.setOutput);

  useSubscription(stats$, (p) => {
    setStats(p);
    patchStatus({
      connected: p.packetRate > 0 || p.activeUniverses > 0,
      packetRate: p.packetRate,
      uptimeSec: p.uptimeSec,
    });
  });
  useSubscription(universes$, setUniverses);
  useSubscription(devices$, setDevices);
  useSubscription(output$, setOutput);
}
