import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { useAppInfo } from "../hooks/useAppInfo";
import { useUpdater } from "../hooks/useUpdater";
import { AppIdentity } from "./AppIdentity";
import { EnvironmentSection } from "./EnvironmentSection";
import { UpdateSection } from "./UpdateSection";

/**
 * 关于页：单卡片，在内容区水平、垂直居中（类似桌面应用的「关于」窗口）。
 *
 * 三块信息自上而下按重要性排列：身份（图标 + 名称 + 版本）→ 软件更新 → 运行环境（默认折叠）。
 * 装饰一律克制：无渐变、无阴影、单一强调色。内容较高时 `min-h-full` 让页面自然滚动而不是被裁切。
 */
export function AboutView() {
  const { t } = useTranslation();
  const { data: info, isError } = useAppInfo();
  const { state, check, install } = useUpdater();

  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="w-full max-w-md">
        {/* 页面标题已由侧栏与顶栏表达，这里仅为读屏保留文档大纲 */}
        <h1 className="sr-only">{t("about.title")}</h1>

        <Card className="divide-y divide-border overflow-hidden">
          <AppIdentity info={info} failed={isError} />
          <UpdateSection
            state={state}
            onCheck={() => void check()}
            onInstall={(update) => void install(update)}
          />
          <EnvironmentSection info={info} />
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("about.copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </div>
  );
}
