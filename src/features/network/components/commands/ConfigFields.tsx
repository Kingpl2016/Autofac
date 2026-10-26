import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** 字段 id 前缀；错误摘要据此把焦点移到对应字段。 */
export const FIELD_PREFIX = "cfg-";

interface FieldShellProps {
  name: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}

/** 字段外壳：标签 + 控件 + 永久帮助文字 + 内联错误。 */
function FieldShell({ name, label, hint, error, children }: FieldShellProps) {
  const id = `${FIELD_PREFIX}${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface TextFieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  mono?: boolean;
  onBlur?: () => void;
}

/** 文本输入字段。 */
export function TextField({ name, label, value, onChange, hint, error, disabled, mono, onBlur }: TextFieldProps) {
  const id = `${FIELD_PREFIX}${name}`;
  return (
    <FieldShell name={name} label={label} hint={hint} error={error}>
      <Input
        id={id}
        className={mono ? "tabular" : undefined}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint ${id}-err`}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </FieldShell>
  );
}

interface NumberFieldProps {
  name: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  onBlur?: () => void;
}

/** 数字输入字段；清空时值为 `NaN`，由校验报错。 */
export function NumberField({ name, label, value, onChange, hint, error, disabled, onBlur }: NumberFieldProps) {
  const id = `${FIELD_PREFIX}${name}`;
  return (
    <FieldShell name={name} label={label} hint={hint} error={error}>
      <Input
        id={id}
        className="tabular"
        inputMode="numeric"
        value={Number.isNaN(value) ? "" : String(value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint ${id}-err`}
        onChange={(e) => onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value))}
        onBlur={onBlur}
      />
    </FieldShell>
  );
}

interface SwitchFieldProps {
  name: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

/** 开关字段：标签在左、开关在右，帮助文字常驻。 */
export function SwitchField({ name, label, checked, onChange, hint, disabled }: SwitchFieldProps) {
  const { t } = useTranslation();
  const id = `${FIELD_PREFIX}${name}`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        {hint && (
          <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground" aria-hidden>
          {checked ? t("common.on") : t("common.off")}
        </span>
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-describedby={`${id}-hint`} />
      </div>
    </div>
  );
}

interface SelectFieldProps {
  name: string;
  label: string;
  value: number;
  options: ReadonlyArray<{ value: number; label: string }>;
  onChange: (v: number) => void;
  hint?: string;
  disabled?: boolean;
}

/** 下拉选择字段（数值枚举）。 */
export function SelectField({ name, label, value, options, onChange, hint, disabled }: SelectFieldProps) {
  const id = `${FIELD_PREFIX}${name}`;
  return (
    <FieldShell name={name} label={label} hint={hint}>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}
