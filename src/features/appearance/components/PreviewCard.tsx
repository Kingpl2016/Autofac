import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePanelPrefsStore } from "../stores/usePanelPrefsStore";
import { focusRingClass } from "./OptionTile";

/** 预览里的一个分组：小标题 + 内容。 */
function PreviewGroup({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 space-y-2", className)}>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 实时预览卡片：直接渲染真实组件与应用自己的令牌（强调色、热力色阶、状态色），
 * 外观设置通过 `<html>` 上的 CSS 变量全局生效，这里不需要额外状态就能实时反映。
 * 默认折叠成一行，展开状态保存在面板偏好里。预览里的输入框只读且不可聚焦，避免干扰键盘导航。
 */
export function PreviewCard() {
  const { t } = useTranslation();
  const open = usePanelPrefsStore((s) => s.previewOpen);
  const setOpen = usePanelPrefsStore((s) => s.setPreviewOpen);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          focusRingClass,
          "flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground",
        )}
      >
        <span>{t("appearance.preview.title")}</span>
        <span className="flex items-center gap-1">
          {open ? t("appearance.preview.collapse") : t("appearance.preview.expand")}
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </span>
      </button>
      {open ? (
        <fieldset className="mt-2 grid max-h-[min(38svh,19rem)] min-w-0 gap-4 overflow-y-auto rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-2">
          <legend className="sr-only">{t("appearance.preview.title")}</legend>
          <PreviewGroup className="sm:col-span-2" title={t("appearance.preview.groupAccent")}>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">{t("appearance.preview.primary")}</Button>
              <Button size="sm" variant="secondary">
                {t("appearance.preview.secondary")}
              </Button>
              <Button size="sm" variant="outline">
                {t("appearance.preview.outline")}
              </Button>
              <Badge>{t("appearance.preview.badge")}</Badge>
              <Switch defaultChecked aria-label={t("appearance.preview.switch")} />
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                <Check aria-hidden className="size-4" />
                {t("appearance.preview.link")}
              </span>
            </div>
          </PreviewGroup>
          <PreviewGroup title={t("appearance.preview.groupCard")}>
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle>{t("appearance.preview.cardTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 p-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("appearance.preview.cardBody")}</p>
                <Input
                  readOnly
                  tabIndex={-1}
                  aria-label={t("appearance.preview.input")}
                  placeholder={t("appearance.preview.input")}
                  className="h-8"
                />
              </CardContent>
            </Card>
          </PreviewGroup>
          <div className="space-y-4">
            <PreviewGroup title={t("appearance.preview.groupStatus")}>
              {/* 状态语义色不随主题与主色变化：录制红、在线绿、告警黄始终代表同一件事 */}
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">{t("appearance.preview.statusOnline")}</Badge>
                <Badge variant="warning">{t("appearance.preview.statusWarning")}</Badge>
                <Badge className="border-transparent bg-recording/15 text-recording">{t("appearance.preview.statusRecording")}</Badge>
              </div>
            </PreviewGroup>
            <PreviewGroup title={t("appearance.preview.groupHeat")}>
              <div aria-hidden className="flex h-6 overflow-hidden rounded-md border border-border">
                {["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4"].map((cls) => (
                  <span key={cls} className={cn("flex-1", cls)} />
                ))}
              </div>
            </PreviewGroup>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
