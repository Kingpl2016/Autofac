/** @file 带说明的开关行：设置面板中“名称 + 一句说明 + 开关”的通用一行 */
import { useId } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** SwitchRow 的组件属性 */
interface SwitchRowProps {
  /** 名称 */
  label: string;
  /** 说明 */
  hint?: string;
  /** 是否开启 */
  checked: boolean;
  /** 切换回调 */
  onCheckedChange: (checked: boolean) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

/**
 * 带说明的开关行。
 *
 * @param props - 组件属性
 * @returns 开关行节点
 *
 * @example
 * ```tsx
 * <SwitchRow label="显示面包屑" hint="在顶栏显示当前位置" checked={on} onCheckedChange={setOn} />
 * ```
 */
export function SwitchRow({ label, hint, checked, onCheckedChange, disabled }: SwitchRowProps) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
