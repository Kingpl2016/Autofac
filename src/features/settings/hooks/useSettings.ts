import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useDebouncedCallback } from "@/shared/hooks/useDebounced";
import { errorMessage } from "@/shared/lib/errors";
import { getSettings, saveSettings } from "../lib/api";
import type { AppSettings } from "../lib/types";

/** 自动保存防抖延迟（毫秒）。 */
const AUTOSAVE_DELAY = 2000;

/** 自动保存状态：空闲 / 待保存（有改动等防抖）/ 保存中 / 已保存 / 失败。 */
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/** 配置查询缓存键。 */
const SETTINGS_QUERY_KEY = ["settings"] as const;

/**
 * 查询当前配置（非 Tauri 预览环境回退默认值）。
 */
export function useSettingsQuery() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getSettings,
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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");

  const persist = useCallback(
    (next: AppSettings) => {
      setStatus("saving");
      void saveSettings(next)
        .then((saved) => {
          // 用后端规范化后的结果刷新缓存，全站读取设置的地方立即生效
          queryClient.setQueryData(SETTINGS_QUERY_KEY, saved);
          setStatus("saved");
          toast.success(t("settings.saved"));
        })
        .catch((e: unknown) => {
          setStatus("error");
          toast.error(errorMessage(e));
        });
    },
    [t, queryClient],
  );

  // 卸载时取消未执行的保存（与改造前一致）
  const autosave = useDebouncedCallback(persist, AUTOSAVE_DELAY);

  const update = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      setStatus("pending");
      setDraft((prev) => {
        const next = updater(prev);
        autosave.schedule(next);
        return next;
      });
    },
    [autosave],
  );

  const replace = useCallback(
    (next: AppSettings) => {
      autosave.cancel();
      setDraft(next);
      persist(next);
    },
    [autosave, persist],
  );

  return { draft, update, replace, status };
}
