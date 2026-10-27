import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { groupOf } from "../../lib/functions";
import { ATTRIBUTE_GROUPS, CHANNEL_FUNCTIONS, type ChannelFunction } from "../../lib/types";

interface FunctionSelectProps {
  value: ChannelFunction;
  onChange: (fn: ChannelFunction) => void;
  /** 读屏标签 */
  label: string;
  className?: string;
}

/** 通道功能下拉框：按属性组（强度 / 颜色 / 位置 / 光束 / 调焦 / 控制）分组列出。 */
export function FunctionSelect({ value, onChange, label, className }: FunctionSelectProps) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ChannelFunction)}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ATTRIBUTE_GROUPS.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{t(`fixtures.groups.${group}`)}</SelectLabel>
            {CHANNEL_FUNCTIONS.filter((fn) => groupOf(fn) === group).map((fn) => (
              <SelectItem key={fn} value={fn}>
                {t(`fixtures.functions.${fn}`)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
