import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import {
  diffConfig,
  patchNeedsReboot,
  toDraft,
  validateConfig,
  type ConfigDraft,
  type ConfigErrors,
} from "../../lib/configForm";
import { errorText } from "../../lib/errors";
import type { ConfigPatch, ConfigResult, DeviceConfig } from "../../lib/types";
import { FIELD_PREFIX, NumberField, SelectField, SwitchField, TextField } from "./ConfigFields";

interface ConfigFormProps {
  access: DeviceAccess;
  config: DeviceConfig;
  save: (patch: ConfigPatch) => Promise<ConfigResult>;
  /** 保存成功；参数表示改动是否需要重启才生效 */
  onSaved: (needsReboot: boolean) => void;
}

const TARGET_MODES = [0, 1] as const;
const STOP_BEHAVIORS = [0, 1] as const;

/**
 * 设备配置表单：网络 / 输出 / 转发三组字段。
 *
 * 草稿由设备配置初始化，父组件在配置刷新后用 `key` 重建本组件，所以不需要 effect 同步。
 * 提交时先本地校验（规则同固件），失败显示可聚焦的错误摘要；通过后只发送改动过的字段。
 */
export function ConfigForm({ access, config, save, onSaved }: ConfigFormProps) {
  const { t } = useTranslation();
  const original = toDraft(config);
  const [draft, setDraft] = useState<ConfigDraft>(original);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof ConfigDraft, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const errors: ConfigErrors = validateConfig(draft);
  const errorEntries = Object.entries(errors) as Array<[keyof ConfigDraft, string]>;
  const patch = diffConfig(original, draft);
  const changed = Object.keys(patch).length;
  const disabled = !access.canWrite || saving;

  const set = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const blur = (key: keyof ConfigDraft) => setTouched((s) => ({ ...s, [key]: true }));
  const err = (key: keyof ConfigDraft) => {
    const k = errors[key];
    return k && (submitted || touched[key]) ? t(k) : null;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (errorEntries.length > 0) {
      setSubmitted(true);
      // 把焦点交给错误摘要，读屏用户立即听到问题所在
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    if (changed === 0) return;
    setSaving(true);
    try {
      const result = await save(patch);
      toast.success(t("network.config.saved"));
      onSaved(result.netRebootRequired || patchNeedsReboot(patch));
    } catch (e) {
      toast.error(errorText(t, e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(original);
    setSubmitted(false);
    setTouched({});
  };

  const focusField = (key: string) => document.getElementById(`${FIELD_PREFIX}${key}`)?.focus();

  return (
    <form className="grid gap-(--density-gutter)" onSubmit={(e) => void submit(e)} noValidate>
      {submitted && errorEntries.length > 0 && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-sm font-semibold text-destructive">
            {t("network.config.errorSummary", { count: errorEntries.length })}
          </p>
          <ul className="mt-1.5 list-disc pl-5 text-xs">
            {errorEntries.map(([key, msg]) => (
              <li key={key}>
                <button type="button" className="text-left underline underline-offset-2" onClick={() => focusField(key)}>
                  {t(`network.config.fields.${key}`)}：{t(msg)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-(--density-gutter) xl:grid-cols-2">
        <SurfacePanel title={t("network.config.groupNetwork")}>
          <div className="grid gap-4">
            <SwitchField
              name="dhcp"
              label={t("network.config.fields.dhcp")}
              hint={t("network.config.hints.dhcp")}
              checked={draft.dhcp}
              disabled={disabled}
              onChange={(v) => set("dhcp", v)}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField name="ip" mono label={t("network.config.fields.ip")} value={draft.ip} disabled={disabled || draft.dhcp} error={err("ip")} onChange={(v) => set("ip", v)} onBlur={() => blur("ip")} />
              <TextField name="netmask" mono label={t("network.config.fields.netmask")} value={draft.netmask} disabled={disabled || draft.dhcp} error={err("netmask")} onChange={(v) => set("netmask", v)} onBlur={() => blur("netmask")} />
              <TextField name="gateway" mono label={t("network.config.fields.gateway")} value={draft.gateway} disabled={disabled || draft.dhcp} error={err("gateway")} onChange={(v) => set("gateway", v)} onBlur={() => blur("gateway")} />
            </div>
            <TextField
              name="hostname"
              label={t("network.config.fields.hostname")}
              hint={t("network.config.hints.hostname")}
              value={draft.hostname}
              disabled={disabled}
              error={err("hostname")}
              onChange={(v) => set("hostname", v)}
              onBlur={() => blur("hostname")}
            />
            <p className="text-xs text-muted-foreground">{t("network.config.hints.netReboot")}</p>
          </div>
        </SurfacePanel>

        <SurfacePanel title={t("network.config.groupOutput")}>
          <div className="grid gap-4">
            <SwitchField name="netOutputEnabled" label={t("network.config.fields.netOutputEnabled")} hint={t("network.config.hints.netOutputEnabled")} checked={draft.netOutputEnabled} disabled={disabled} onChange={(v) => set("netOutputEnabled", v)} />
            <SwitchField name="artnetEnabled" label={t("network.config.fields.artnetEnabled")} checked={draft.artnetEnabled} disabled={disabled} onChange={(v) => set("artnetEnabled", v)} />
            <SwitchField name="sacnEnabled" label={t("network.config.fields.sacnEnabled")} checked={draft.sacnEnabled} disabled={disabled} onChange={(v) => set("sacnEnabled", v)} />
            <SwitchField name="uartOutputEnabled" label={t("network.config.fields.uartOutputEnabled")} hint={t("network.config.hints.uartOutputEnabled")} checked={draft.uartOutputEnabled} disabled={disabled} onChange={(v) => set("uartOutputEnabled", v)} />
            <SwitchField name="sacnMulticast" label={t("network.config.fields.sacnMulticast")} checked={draft.sacnMulticast === 1} disabled={disabled} onChange={(v) => set("sacnMulticast", v ? 1 : 0)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField name="targetMode" label={t("network.config.fields.targetMode")} value={draft.targetMode} disabled={disabled} options={TARGET_MODES.map((v) => ({ value: v, label: t(`network.config.targetMode.${v}`) }))} onChange={(v) => set("targetMode", v)} />
              <SelectField name="stopBehavior" label={t("network.config.fields.stopBehavior")} value={draft.stopBehavior} disabled={disabled} options={STOP_BEHAVIORS.map((v) => ({ value: v, label: t(`network.config.stopBehavior.${v}`) }))} onChange={(v) => set("stopBehavior", v)} />
              <NumberField name="sacnPriority" label={t("network.config.fields.sacnPriority")} hint={t("network.config.hints.sacnPriority")} value={draft.sacnPriority} disabled={disabled} error={err("sacnPriority")} onChange={(v) => set("sacnPriority", v)} onBlur={() => blur("sacnPriority")} />
              <NumberField name="keepaliveMs" label={t("network.config.fields.keepaliveMs")} hint={t("network.config.hints.keepaliveMs")} value={draft.keepaliveMs} disabled={disabled} error={err("keepaliveMs")} onChange={(v) => set("keepaliveMs", v)} onBlur={() => blur("keepaliveMs")} />
            </div>
            <TextField name="sourceName" label={t("network.config.fields.sourceName")} value={draft.sourceName} disabled={disabled} error={err("sourceName")} onChange={(v) => set("sourceName", v)} onBlur={() => blur("sourceName")} />
          </div>
        </SurfacePanel>
      </div>

      <SurfacePanel title={t("network.config.groupForward")}>
        <div className="grid items-start gap-4 sm:grid-cols-3">
          <NumberField name="forwardUniStart" label={t("network.config.fields.forwardUniStart")} hint={t("network.config.hints.forwardUniStart")} value={draft.forwardUniStart} disabled={disabled} error={err("forwardUniStart")} onChange={(v) => set("forwardUniStart", v)} onBlur={() => blur("forwardUniStart")} />
          <NumberField name="forwardUniCount" label={t("network.config.fields.forwardUniCount")} hint={t("network.config.hints.forwardUniCount")} value={draft.forwardUniCount} disabled={disabled} error={err("forwardUniCount")} onChange={(v) => set("forwardUniCount", v)} onBlur={() => blur("forwardUniCount")} />
          <div className="sm:pt-6">
            <SwitchField name="forwardSacn" label={t("network.config.fields.forwardSacn")} hint={t("network.config.hints.forwardSacn")} checked={draft.forwardSacn} disabled={disabled} onChange={(v) => set("forwardSacn", v)} />
          </div>
        </div>
      </SurfacePanel>

      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 shadow-lg">
        <span className="mr-auto text-xs text-muted-foreground" role="status">
          {changed > 0 ? t("network.config.changed", { count: changed }) : t("network.config.noChanges")}
        </span>
        <Button type="button" variant="outline" disabled={changed === 0 || saving} onClick={discard}>
          {t("network.config.discard")}
        </Button>
        <Button type="submit" disabled={!access.canWrite || changed === 0 || saving}>
          {saving ? t("network.form.saving") : t("network.config.saveChanges")}
        </Button>
      </div>
    </form>
  );
}
