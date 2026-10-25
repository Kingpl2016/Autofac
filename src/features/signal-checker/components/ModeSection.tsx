import { useTranslation } from "react-i18next";
import { SlidersVertical, Zap } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { setMode } from "../lib/api";
import type { SendMode } from "../lib/types";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { ManualPanel } from "./ManualPanel";
import { PatternPanel } from "./PatternPanel";
import { PreviewPanel } from "./PreviewPanel";

/**
 * 自动 / 手动模式切换及对应面板。
 *
 * 切换立即下发后端，发送中也可以切。只渲染当前模式的面板（标签页内容不保留挂载），
 * 这样离开的面板会自动关掉它的预览推送。
 */
export function ModeSection() {
  const { t } = useTranslation();
  const mode = useCheckerFormStore((s) => s.mode);
  const storeMode = useCheckerFormStore((s) => s.setMode);

  const change = (next: string) => {
    const m = next as SendMode;
    storeMode(m);
    void setMode(m).catch(() => undefined);
  };

  return (
    <Tabs value={mode} onValueChange={change}>
      <TabsList aria-label={t("signalChecker.modeLabel")} className="w-full max-w-md">
        <TabsTrigger value="auto" className="flex-1">
          <Zap className="size-4" aria-hidden />
          {t("signalChecker.modeAuto")}
        </TabsTrigger>
        <TabsTrigger value="manual" className="flex-1">
          <SlidersVertical className="size-4" aria-hidden />
          {t("signalChecker.modeManual")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="auto" className="mt-(--density-gap) grid gap-(--density-gap)">
        <PatternPanel />
        <PreviewPanel />
      </TabsContent>
      <TabsContent value="manual" className="mt-(--density-gap)">
        <ManualPanel />
      </TabsContent>
    </Tabs>
  );
}
