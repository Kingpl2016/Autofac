import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * 返回“复制到剪贴板并提示”的稳定回调。
 *
 * @returns `(value) => void`：复制成功弹出“已复制 xxx”；剪贴板不可用时静默忽略。
 */
export function useCopyToClipboard(): (value: string) => void {
  const { t } = useTranslation();
  return useCallback(
    (value: string) => {
      void navigator.clipboard
        ?.writeText(value)
        .then(() => toast.success(t("discovery.copied", { value })))
        .catch(() => undefined);
    },
    [t],
  );
}
