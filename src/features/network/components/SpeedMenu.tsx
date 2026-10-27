import { ChevronDown, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SPEED_STEPS } from "../lib/types";

interface SpeedMenuProps {
  /** 当前倍速 ×100 */
  value: number;
  disabled?: boolean;
  onChange: (speedX100: number) => void;
  className?: string;
}

/** 倍速文字，如 `1.5×`。 */
const speedLabel = (x100: number) => `${x100 / 100}×`;

/**
 * 倍速选择：按钮显示当前倍速，下拉里单选 7 个档位。
 * 比一排 7 段的分段控件省地方，窄宽度下也不会换行。
 */
export function SpeedMenu({ value, disabled, onChange, className }: SpeedMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={className ?? "h-9 gap-1.5 px-3"}
          disabled={disabled}
          aria-label={`${t("network.player.speed")}: ${speedLabel(value)}`}
        >
          <Gauge aria-hidden />
          <span className="num">{speedLabel(value)}</span>
          <ChevronDown className="text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuLabel>{t("network.player.speed")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(value)} onValueChange={(v) => onChange(Number(v))}>
          {SPEED_STEPS.map((s) => (
            <DropdownMenuRadioItem key={s} value={String(s)} className="num">
              {speedLabel(s)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
