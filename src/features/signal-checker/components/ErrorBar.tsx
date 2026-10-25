import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { OctagonAlert, X } from "lucide-react";

import { useSenderStore } from "../stores/useSenderStore";

/** 发送错误自动消失的时间（毫秒）。 */
const AUTO_DISMISS_MS = 5000;

/**
 * 发送错误条：显示后端上报的最新一条发送错误，5 秒后自动消失，也可手动关闭。
 *
 * 用 `role="alert"` 让读屏软件立即播报。后端已对相同文案做 1 秒限流，所以不会刷屏。
 */
export function ErrorBar() {
  const { t } = useTranslation();
  const error = useSenderStore((s) => s.error);
  const clearError = useSenderStore((s) => s.clearError);

  useEffect(() => {
    if (!error) return;
    const id = error.id;
    const timer = setTimeout(() => clearError(id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  if (!error) return null;
  const where =
    error.universe === null ? "" : t("signalChecker.sendErrorWhere", { universe: error.universe });

  return (
    <div
      role="alert"
      className="mx-6 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {t("signalChecker.sendError", { where, message: error.message })}
      </span>
      <button
        type="button"
        aria-label={t("signalChecker.dismissError")}
        className="rounded p-0.5 hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => clearError(error.id)}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
