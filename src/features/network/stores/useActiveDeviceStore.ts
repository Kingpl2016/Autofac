import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs } from "@/shared/stores/persistPrefs";

interface ActiveDeviceState {
  /** 当前选中的设备 id（可能指向已被删除的设备，读取方需回退）。 */
  activeId: string | null;
  /** 选中设备。 */
  setActiveId: (id: string | null) => void;
}

/** 落盘字段。 */
interface Persisted {
  activeId: string | null;
}

/**
 * 当前设备选择，经 Tauri Store 持久化到 `ui-prefs.json`（键 `net-active-device`）。
 * 只记住 id；设备清单本身由后端注册表持有。
 */
export const useActiveDeviceStore = create<ActiveDeviceState>()(
  persist(
    (set) => ({
      activeId: null,
      setActiveId: (activeId) => set({ activeId }),
    }),
    persistPrefs<ActiveDeviceState, Persisted>({
      name: "net-active-device",
      version: 1,
      // 磁盘数据不是字符串时当作没有选中
      schema: z.object({ activeId: z.string().nullable().catch(null) }),
    }),
  ),
);
