import { useTranslation } from "react-i18next";

import { Segmented } from "@/shared/components/Segmented";
import { setSpeed } from "../lib/api";
import { SPEED_STEPS, useCheckerFormStore } from "../stores/useCheckerFormStore";

interface SpeedControlProps {
  /** 静态图案与时间无关，速度不起作用：控件置灰并说明原因 */
  disabled?: boolean;
}

/**
 * 倍速选择（0.25× 到 4×）。
 *
 * 改变速度不会让当前画面跳变（后端按"经过时间 × 速度"累加相位）；发送中也可随时调。
 */
export function SpeedControl({ disabled = false }: SpeedControlProps) {
  const { t } = useTranslation();
  const speed = useCheckerFormStore((s) => s.speed);
  const storeSpeed = useCheckerFormStore((s) => s.setSpeed);

  const choose = (value: string) => {
    const next = Number(value);
    storeSpeed(next);
    void setSpeed(next).catch(() => undefined);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium">{t("signalChecker.speed")}</span>
      <Segmented
        ariaLabel={t("signalChecker.speed")}
        value={String(speed)}
        options={SPEED_STEPS.map((x) => ({
          value: String(x),
          label: t("signalChecker.speedValue", { x }),
          disabled,
        }))}
        onChange={choose}
      />
      {disabled && (
        <span className="text-xs text-muted-foreground">{t("signalChecker.speedStatic")}</span>
      )}
    </div>
  );
}
