import { useTranslation } from "react-i18next";
import { CircleAlert, Waypoints } from "lucide-react";

import type { AppInfo } from "../lib/api";

interface AppIdentityProps {
  /** 应用元信息；读取中为 `undefined` */
  info: AppInfo | undefined;
  /** 读取应用元信息失败 */
  failed: boolean;
}

/**
 * 应用身份区（居中）：图标 + 名称 + 版本，仅此三样。
 * 图标是描边的平面方块，不加渐变与光晕，让信息本身成为视觉重点。
 */
export function AppIdentity({ info, failed }: AppIdentityProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <div
        className="flex size-16 items-center justify-center rounded-2xl border border-border bg-muted/50 text-primary"
        aria-hidden
      >
        <Waypoints className="size-8" />
      </div>

      <h2 className="mt-4 text-xl font-semibold tracking-tight">
        {info?.name ?? t("common.appName")}
      </h2>

      {failed ? (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" aria-hidden />
          {t("about.infoError")}
        </p>
      ) : info ? (
        <p className="tabular mt-1 text-sm text-muted-foreground">
          {t("about.version", { version: info.version })}
        </p>
      ) : (
        // 读取中的占位：与版本行等高，加载完成后不跳动
        <div className="mt-1.5 h-4 w-24 animate-pulse rounded bg-muted" role="status">
          <span className="sr-only">{t("about.infoLoading")}</span>
        </div>
      )}
    </div>
  );
}
