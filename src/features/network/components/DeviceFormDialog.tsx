import { useState } from "react";
import { Eye, EyeOff, Loader2, Plug, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { netdevProbe, netdevStatus } from "../lib/api";
import { errorText, isUnauthorized } from "../lib/errors";
import type { NetDevice } from "../lib/types";
import { validateHost, validateName, validatePort, validateToken } from "../lib/validate";

/** 预填值（来自设备发现）。 */
export interface DeviceDraft {
  name: string;
  host: string;
  port: number;
}

interface DeviceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑已有设备；为空表示新增。 */
  device?: NetDevice | null;
  /** 新增时的预填值。 */
  draft?: DeviceDraft | null;
  /** 保存设备，返回保存后的设备 id；Token 由对话框另行设置。 */
  onSave: (input: { id?: string; name: string; host: string; port: number }) => Promise<{ id: string }>;
  /** 设置或清除 Token。 */
  onSetToken: (id: string, token: string) => Promise<void>;
}

type Probe =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; version: string }
  | { kind: "needToken" }
  | { kind: "error"; message: string };

/**
 * 添加 / 编辑设备对话框。
 *
 * 每次打开都是全新实例（外层不渲染则不挂载），表单状态用初值初始化，不靠 effect 重置。
 */
export function DeviceFormDialog(props: DeviceFormDialogProps) {
  if (!props.open) return null;
  return <DeviceForm {...props} />;
}

function DeviceForm({ onOpenChange, device, draft, onSave, onSetToken }: DeviceFormDialogProps) {
  const { t } = useTranslation();
  const editing = Boolean(device);
  const [name, setName] = useState(device?.name ?? draft?.name ?? "");
  const [host, setHost] = useState(device?.host ?? draft?.host ?? "");
  const [port, setPort] = useState(String(device?.port ?? draft?.port ?? 80));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const portNum = Number(port);
  const errors = {
    name: validateName(name),
    host: validateHost(host),
    port: validatePort(portNum),
    token: validateToken(token),
  };
  const valid = Object.values(errors).every((e) => e === null);
  const touch = (k: string) => setTouched((s) => ({ ...s, [k]: true }));
  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : null);

  const test = async () => {
    setTouched({ name: true, host: true, port: true, token: true });
    if (!valid) return;
    setProbe({ kind: "testing" });
    try {
      // 编辑且没改地址 / 没填新 Token 时，用已保存的 Token 测试
      const unchanged = device && host.trim() === device.host && portNum === device.port && token === "";
      const status = unchanged
        ? await netdevStatus(device.id)
        : await netdevProbe(host.trim(), portNum, token || undefined);
      setProbe({ kind: "ok", version: status.version });
    } catch (e) {
      setProbe(isUnauthorized(e) ? { kind: "needToken" } : { kind: "error", message: errorText(t, e) });
    }
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setTouched({ name: true, host: true, port: true, token: true });
    if (!valid) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const saved = await onSave({ id: device?.id, name: name.trim(), host: host.trim(), port: portNum });
      if (token !== "") {
        try {
          await onSetToken(saved.id, token);
        } catch (e) {
          toast.error(t("network.form.saveFailed", { reason: errorText(t, e) }));
        }
      }
      onOpenChange(false);
    } catch (e) {
      setSubmitError(t("network.form.saveFailed", { reason: errorText(t, e) }));
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    if (!device) return;
    try {
      await onSetToken(device.id, "");
      toast.success(t("network.form.tokenCleared"));
      onOpenChange(false);
    } catch (e) {
      setSubmitError(t("network.form.saveFailed", { reason: errorText(t, e) }));
    }
  };

  const err = (key: string | null) => (key ? t(key) : null);

  return (
    <Dialog open onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("network.form.editTitle") : t("network.form.addTitle")}</DialogTitle>
          <DialogDescription>{t("network.form.description")}</DialogDescription>
        </DialogHeader>

        <form id="net-device-form" className="grid gap-5" onSubmit={(e) => void submit(e)} noValidate>
          <Field id="nd-name" label={t("network.form.name")} error={err(show("name"))}>
            <Input
              id="nd-name"
              value={name}
              placeholder={t("network.form.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => touch("name")}
              aria-invalid={show("name") ? true : undefined}
              aria-describedby={show("name") ? "nd-name-err" : undefined}
              autoComplete="off"
            />
          </Field>

          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <Field
              id="nd-host"
              label={t("network.form.host")}
              hint={t("network.form.hostHint")}
              error={err(show("host"))}
            >
              <Input
                id="nd-host"
                className="tabular"
                value={host}
                placeholder="192.168.1.200"
                onChange={(e) => {
                  setHost(e.target.value);
                  setProbe({ kind: "idle" });
                }}
                onBlur={() => touch("host")}
                aria-invalid={show("host") ? true : undefined}
                aria-describedby="nd-host-hint nd-host-err"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field id="nd-port" label={t("network.form.port")} error={err(show("port"))}>
              <Input
                id="nd-port"
                className="tabular"
                inputMode="numeric"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  setProbe({ kind: "idle" });
                }}
                onBlur={() => touch("port")}
                aria-invalid={show("port") ? true : undefined}
                aria-describedby={show("port") ? "nd-port-err" : undefined}
              />
            </Field>
          </div>

          <Field
            id="nd-token"
            label={t("network.form.token")}
            hint={editing && device?.hasToken ? t("network.form.tokenKeep") : t("network.form.tokenHint")}
            error={err(show("token"))}
          >
            <div className="flex gap-2">
              <Input
                id="nd-token"
                className="tabular"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setProbe({ kind: "idle" });
                }}
                onBlur={() => touch("token")}
                aria-invalid={show("token") ? true : undefined}
                aria-describedby="nd-token-hint nd-token-err"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showToken ? t("network.form.hideToken") : t("network.form.showToken")}
                aria-pressed={showToken}
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>

          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("network.form.tokenWarning")}
          </p>

          <div className="flex flex-wrap items-center gap-3" aria-live="polite">
            <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={probe.kind === "testing"}>
              {probe.kind === "testing" ? <Loader2 className="animate-spin" /> : <Plug />}
              {probe.kind === "testing" ? t("network.form.testing") : t("network.form.test")}
            </Button>
            {probe.kind === "ok" && (
              <span className="text-xs font-medium text-success">{t("network.form.testOk", { version: probe.version })}</span>
            )}
            {probe.kind === "needToken" && (
              <span className="text-xs font-medium text-warning">{t("network.form.testNeedToken")}</span>
            )}
            {probe.kind === "error" && <span className="text-xs font-medium text-destructive">{probe.message}</span>}
          </div>

          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}
        </form>

        <DialogFooter className="items-center">
          {editing && device?.hasToken && (
            <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => void clearToken()} disabled={saving}>
              {t("network.form.clearToken")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="net-device-form" disabled={saving}>
            {saving ? t("network.form.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}

/** 表单字段外壳：标签 + 控件 + 永久可见的帮助文字 + 内联错误。 */
function Field({ id, label, hint, error, children }: FieldProps) {
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
