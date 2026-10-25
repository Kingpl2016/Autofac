import { useTranslation } from "react-i18next";
import { Wifi } from "lucide-react";

import { draftToConfig } from "../lib/draft";
import { protocolLabel } from "../lib/errors";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { useSenderStore } from "../stores/useSenderStore";

/**
 * 底栏：当前生效的 `协议 → IP:端口`，以及 Universe 范围和当前图案（手动模式显示“手动模式”）。
 *
 * 优先显示后端实际生效的配置；还没收到状态时退回到草稿，所以窗口一打开就有内容。
 */
export function CheckerFooter() {
  const { t } = useTranslation();
  const applied = useSenderStore((s) => s.status?.config);
  const draft = useCheckerFormStore((s) => s.draft);
  const mode = useCheckerFormStore((s) => s.mode);
  const pattern = useCheckerFormStore((s) => s.pattern);
  const config = applied ?? draftToConfig(draft);

  return (
    <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-card px-6 py-2 text-xs text-muted-foreground">
      {config ? (
        <>
          <span className="tabular flex min-w-0 items-center gap-1.5">
            <Wifi className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {t("signalChecker.footerTarget", {
                protocol: protocolLabel(config.protocol),
                ip: config.targetIp,
                port: config.port,
              })}
            </span>
          </span>
          <span className="tabular truncate">
            {t("signalChecker.footerUniverses", { range: config.universes })}
            {" · "}
            {mode === "manual"
              ? t("signalChecker.modeManual")
              : t("signalChecker.footerPattern", { name: t(`signalChecker.patterns.${pattern}.name`) })}
          </span>
        </>
      ) : null}
    </footer>
  );
}
