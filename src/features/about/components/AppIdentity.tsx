import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";

import { AppLogo } from "@/shared/components/AppLogo";

import type { AppInfo } from "../lib/api";

interface AppIdentityProps {
  /** 应用元信息；读取中为 `undefined` */
  info: AppInfo | undefined;
  /** 读取应用元信息失败 */
  failed: boolean;
}

/**
 * 应用身份区（居中）：标志 + 名称 + 一句话简介 + 版本。
 * 标志下面有一圈很淡的主题色光晕，让这一块成为整张卡片的视觉重心；其余部分保持克制。
 */
export function AppIdentity({ info, failed }: AppIdentityProps) {
  const { t } = useTranslation();

  return (
    <div className="relative isolate flex flex-col items-center overflow-hidden px-6 pb-8 pt-10 text-center">
      {/* 背景光晕：只用主题色的低透明度渐变，深浅主题都适用 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-48 bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_20%,transparent),transparent_70%)]"
      />

      <AppLogo className="size-24 drop-shadow-[0_10px_28px_color-mix(in_oklab,var(--primary)_35%,transparent)]" />

      <h2 className="mt-5 text-2xl font-semibold tracking-tight">
        {info?.name ?? t("common.appName")}
      </h2>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{t("about.tagline")}</p>

      <div className="mt-4 flex h-7 items-center">
        {failed ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" aria-hidden />
            {t("about.infoError")}
          </p>
        ) : info ? (
          <span className="tabular inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            {t("about.version", { version: info.version })}
          </span>
        ) : (
          // 读取中的占位：与版本徽标等高，加载完成后不跳动
          <Skeleton className="h-6 w-24 rounded-full bg-muted" role="status">
            <span className="sr-only">{t("about.infoLoading")}</span>
          </Skeleton>
        )}
      </div>
    </div>
  );
}
