import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/components/PageHeader";
import { ForwardingEditor } from "./ForwardingEditor";
import { FORWARDING_QUERY_KEY, useForwardingQuery } from "../hooks/useForwarding";
import { readForwardingPrefill } from "../lib/prefill";
import type { ForwardDestination } from "../lib/types";

/**
 * 转发页：加载完成后挂载编辑器（以初始表播种草稿）。
 *
 * 如果是从别的页面（如设备发现）带着预填信息跳转过来，首次渲染时读取一次交给编辑器，
 * 随后清掉路由 state，避免刷新或回退时重复弹出。加载失败时显示错误和重试按钮，
 * 不会一直停在“加载中”。
 */
export function ForwardingView() {
  const { t } = useTranslation();
  const query = useForwardingQuery();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [prefill] = useState(() => readForwardingPrefill(location.state));
  const cleared = useRef(false);

  useEffect(() => {
    if (!prefill || cleared.current) return;
    cleared.current = true;
    navigate(location.pathname, { replace: true, state: null });
  }, [prefill, navigate, location.pathname]);

  // 保存成功后把缓存同步成刚保存的内容，仪表盘等其它读取转发表的地方立刻看到最新数据
  const handleSaved = useCallback(
    (list: ForwardDestination[]) =>
      queryClient.setQueryData(FORWARDING_QUERY_KEY, { destinations: list }),
    [queryClient],
  );

  if (!query.data) {
    return (
      <div>
        <PageHeader title={t("forwarding.title")} subtitle={t("forwarding.subtitle")} />
        {query.isError ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-10 text-sm">
            <span className="text-destructive">{t("forwarding.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("forwarding.retry")}
            </Button>
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        )}
      </div>
    );
  }
  return <ForwardingEditor initial={query.data} prefill={prefill} onSaved={handleSaved} />;
}