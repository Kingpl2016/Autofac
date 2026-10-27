import { Film } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";

/** 顶栏的“播放中”徽章：只在真正播放时出现。录制状态由录制按钮自己表达。 */
export function PlaybackBadge() {
  const { t } = useTranslation();
  const playing = useEngineStatusStore((s) => s.playing);
  if (!playing) return null;
  return (
    <Badge variant="success">
      <Film className="size-3" aria-hidden />
      {t("header.playback")}
    </Badge>
  );
}
