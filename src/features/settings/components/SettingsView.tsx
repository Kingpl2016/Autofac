import { useTranslation } from "react-i18next";

import { PageHeader } from "@/shared/components/PageHeader";
import { SettingsEditor } from "./SettingsEditor";
import { useSettingsQuery } from "../hooks/useSettings";

/**
 * 设置页：加载完成前显示占位，完成后挂载编辑器（以初始配置播种草稿）。
 */
export function SettingsView() {
  const { t } = useTranslation();
  const query = useSettingsQuery();

  if (!query.data) {
    return (
      <div>
        <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
        <div className="py-10 text-center text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      </div>
    );
  }

  return <SettingsEditor initial={query.data} />;
}
