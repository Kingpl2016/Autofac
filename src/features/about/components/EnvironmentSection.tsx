import { useTranslation } from "react-i18next";
import { ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { AppInfo } from "../lib/api";
import { buildDiagnostics } from "../lib/format";

interface EnvironmentSectionProps {
  /** 应用元信息；读取中或失败时为 `undefined` */
  info: AppInfo | undefined;
}

/**
 * 运行环境区：默认折叠，只有需要排查问题时才展开。
 * 展开后是一张朴素的「名称 / 值」清单（系统、架构、构建类型），末尾一个按钮复制为诊断文本。
 * 使用原生 `<details>`：键盘（Enter / 空格）与读屏开箱即用，无需额外状态。
 */
export function EnvironmentSection({ info }: EnvironmentSectionProps) {
  const { t } = useTranslation();

  const copy = () => {
    if (!info) return;
    void navigator.clipboard
      ?.writeText(buildDiagnostics(info))
      .then(() => toast.success(t("about.copied")))
      .catch(() => undefined);
  };

  const rows: { label: string; value: string | undefined }[] = [
    { label: t("about.os"), value: info?.os },
    { label: t("about.arch"), value: info?.arch },
    {
      label: t("about.profile"),
      value: info && t(info.profile === "debug" ? "about.profileDebug" : "about.profileRelease"),
    },
  ];

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-center gap-1.5 px-6 py-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        {t("about.systemTitle")}
      </summary>

      <div className="px-6 pb-5">
        <dl className="divide-y divide-border rounded-lg border border-border">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between gap-6 px-4 py-2.5 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular min-w-0 truncate" title={value}>
                {value ?? "—"}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" disabled={!info} onClick={copy}>
            <Copy />
            {t("about.copyInfo")}
          </Button>
        </div>
      </div>
    </details>
  );
}
