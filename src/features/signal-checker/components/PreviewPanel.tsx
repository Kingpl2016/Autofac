import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { useSettingsQuery } from "@/features/settings";
import { ChannelGrid } from "@/features/universes";
import { useUniverseFrame } from "../hooks/useUniverseFrame";
import { useViewedUniverse } from "../hooks/useViewedUniverse";
import { UniverseSelect } from "./UniverseSelect";

/**
 * 发送预览：选一个发送范围内的 Universe，看它当前发出的 512 个通道。
 *
 * 发送中跟随后端推送的预览帧（约 9Hz），未发送时显示图案的起点。数值格式沿用设置里的"通道值格式"。
 */
export function PreviewPanel() {
  const { t } = useTranslation();
  const selectId = useId();
  const { universe, universes, setUniverse } = useViewedUniverse();
  const frame = useUniverseFrame(universe);
  const settings = useSettingsQuery();
  const valueFormat = settings.data?.display.valueFormat ?? "decimal";

  return (
    <SurfacePanel
      title={t("signalChecker.previewTitle")}
      actions={
        <>
          <Label htmlFor={selectId}>{t("signalChecker.previewUniverse")}</Label>
          <UniverseSelect id={selectId} universes={universes} value={universe} onChange={setUniverse} />
        </>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{t("signalChecker.previewHint")}</p>
      {universe !== null && <ChannelGrid universe={universe} valueFormat={valueFormat} data={frame} />}
    </SurfacePanel>
  );
}
