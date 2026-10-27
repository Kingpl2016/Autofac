import { useDmxStream } from "@/shared/hooks/useDmxStream";
import { useEngineListeners } from "@/shared/hooks/useEngineListeners";
import { useSystemLog } from "@/shared/hooks/useSystemLog";

/** 引擎的无界面运行时：系统日志、引擎事件、二进制通道流各订阅一次。 */
export function EngineRuntime() {
  useSystemLog();
  useEngineListeners();
  useDmxStream();
  return null;
}
