import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { isTauri } from "@/shared/tauri/invoke";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../lib/api";
import type { AppSettings } from "../lib/types";

/** 自动保存防抖延迟（毫秒）。 */
const AUTOSAVE_DELAY = 2000;

/**
 * 查询当前配置（非 Tauri 预览环境回退默认值）。
 */
export function useSettingsQuery() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    initialData: isTauri() ? undefined : DEFAULT_SETTINGS,
  });
}

/**
 * 维护配置草稿：首次以 `initial` 播种（只在组件挂载时执行一次），
 * 变更后 2 秒防抖自动保存。
 *
 * @param initial 初始配置（父组件保证已加载）。
 * @returns 草稿、更新函数与立即替换函数。
 */
export function useSettingsDraft(initial: AppSettings) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (next: AppSettings) => {
      if (!isTauri()) return;
      void saveSettings(next)
        .then(() => toast.success(t("settings.saved")))
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : String(e)),
        );
    },
    [t],
  );

  const scheduleSave = useCallback(
    (next: AppSettings) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY);
    },
    [persist],
  );

  const update = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      setDraft((prev) => {
        const next = updater(prev);
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const replace = useCallback(
    (next: AppSettings) => {
      if (timer.current) clearTimeout(timer.current);
      setDraft(next);
      persist(next);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { draft, update, replace };
}
