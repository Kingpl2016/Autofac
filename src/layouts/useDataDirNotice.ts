import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getDataDir } from "@/shared/tauri/dataDir";

/**
 * 启动时检查数据目录：软件目录没有写权限而退回了系统应用数据目录时，提示一次数据实际保存在哪里。
 *
 * 正常情况下数据在软件目录下的 `data`，不需要提示。查询失败（没有 Tauri 后端）时什么也不做。
 */
export function useDataDirNotice(): void {
  const { t } = useTranslation();
  useEffect(() => {
    let alive = true;
    void getDataDir().then((info) => {
      if (alive && info?.fallbackUsed) {
        toast.warning(t("dataDir.fallback", { path: info.path }), { duration: 15_000 });
      }
    });
    return () => {
      alive = false;
    };
  }, [t]);
}