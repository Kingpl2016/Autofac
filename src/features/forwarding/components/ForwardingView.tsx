import { useTranslation } from "react-i18next";

import { PageHeader } from "@/shared/components/PageHeader";
import { ForwardingEditor } from "./ForwardingEditor";
import { useForwardingQuery } from "../hooks/useForwarding";

/**
 * 转发页：加载完成后挂载编辑器（以初始表播种草稿）。
 */
export function ForwardingView() {
  const { t } = useTranslation();
  const query = useForwardingQuery();

  if (!query.data) {
    return (
      <div>
        <PageHeader title={t("forwarding.title")} subtitle={t("forwarding.subtitle")} />
        <div className="py-10 text-center text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      </div>
    );
  }
  return <ForwardingEditor initial={query.data} />;
}
