import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { PageHeader } from "@/shared/components/PageHeader";
import { ForwardingEditor } from "./ForwardingEditor";
import { useForwardingQuery } from "../hooks/useForwarding";
import { readForwardingPrefill } from "../lib/prefill";

/**
 * 转发页：加载完成后挂载编辑器（以初始表播种草稿）。
 *
 * 如果是从别的页面（如设备发现）带着预填信息跳转过来，首次渲染时读取一次交给编辑器，
 * 随后清掉路由 state，避免刷新或回退时重复弹出。
 */
export function ForwardingView() {
  const { t } = useTranslation();
  const query = useForwardingQuery();
  const location = useLocation();
  const navigate = useNavigate();
  const [prefill] = useState(() => readForwardingPrefill(location.state));
  const cleared = useRef(false);

  useEffect(() => {
    if (!prefill || cleared.current) return;
    cleared.current = true;
    navigate(location.pathname, { replace: true, state: null });
  }, [prefill, navigate, location.pathname]);

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
  return <ForwardingEditor initial={query.data} prefill={prefill} />;
}
