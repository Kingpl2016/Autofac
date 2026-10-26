import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useProtocolFlags } from "@/features/settings";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { TargetIpField } from "./TargetIpField";
import { applyDeviceSelection, applyProtocol } from "../lib/deviceOptions";
import {
  parseRange,
  type ForwardDestination,
  type OverrideAction,
} from "../lib/types";
import {
  firstError,
  hasErrors,
  validateDestination,
  type DestinationField,
  type ValidationCode,
} from "../lib/validate";

interface DestinationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ForwardDestination;
  onSave: (dest: ForwardDestination) => void;
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  className?: string;
  children: ReactNode;
}

/** 带标签与内联错误的表单项；错误文字通过 `id-error` 与输入框关联。 */
function Field({ id, label, error, className, children }: FieldProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 目的地新增/编辑对话框：全字段 + per-universe 覆盖编辑 + 范围批量添加。
 *
 * 点击保存时才校验；校验不通过会在字段下方显示原因并把焦点移到第一个出错的字段，
 * 之后随修改实时更新。
 */
export function DestinationDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: DestinationDialogProps) {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const devices = useEngineDataStore((s) => s.devices);
  const base = useId();
  const [draft, setDraft] = useState<ForwardDestination>(initial);
  const [rangeText, setRangeText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const patch = (p: Partial<ForwardDestination>) =>
    setDraft((d) => ({ ...d, ...p }));

  const errors = validateDestination(draft);
  const idOf = (f: DestinationField) => `${base}-${f}`;
  const msg = (code?: ValidationCode) =>
    submitted && code ? t(`forwarding.error.${code}`) : undefined;
  const invalid = (f: DestinationField) =>
    submitted && errors.fields[f] ? { "aria-invalid": true, "aria-describedby": `${idOf(f)}-error` } : {};

  const addOverride = () =>
    patch({
      overrides: [
        ...draft.overrides,
        { sourceUniverse: 0, action: "forward", targetUniverse: null, delayMs: null },
      ],
    });

  const applyRange = () => {
    const unis = parseRange(rangeText);
    const existing = new Set(draft.overrides.map((o) => o.sourceUniverse));
    const added = unis
      .filter((u) => !existing.has(u))
      .map((u) => ({
        sourceUniverse: u,
        action: "forward" as OverrideAction,
        targetUniverse: null,
        delayMs: null,
      }));
    patch({ overrides: [...draft.overrides, ...added] });
    setRangeText("");
  };

  const handleSave = () => {
    if (hasErrors(errors)) {
      setSubmitted(true);
      const first = firstError(errors);
      // 把焦点交给第一个出错的字段，键盘与读屏用户能立刻定位
      if (first && first.field in errors.fields) {
        document.getElementById(idOf(first.field as DestinationField))?.focus();
      }
      return;
    }
    onSave({ ...draft, name: draft.name.trim(), targetIp: draft.targetIp.trim() });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initial.name ? t("forwarding.editDestination") : t("forwarding.addDestination")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field
            id={idOf("name")}
            label={t("forwarding.name")}
            error={msg(errors.fields.name)}
            className="col-span-2"
          >
            <Input
              id={idOf("name")}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              {...invalid("name")}
            />
          </Field>
          <TargetIpField
            id={idOf("targetIp")}
            label={t("forwarding.targetIp")}
            value={draft.targetIp}
            error={msg(errors.fields.targetIp)}
            devices={devices}
            sacnEnabled={sacnEnabled}
            onManualChange={(ip) => patch({ targetIp: ip })}
            onPick={(device) => setDraft((d) => applyDeviceSelection(d, device, sacnEnabled))}
          />
          {sacnEnabled && (
            <div className="grid gap-1.5">
              <Label>{t("forwarding.protocol")}</Label>
              <Select
                value={draft.protocol}
                onValueChange={(v) =>
                  setDraft((d) => applyProtocol(d, v as ForwardDestination["protocol"]))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="artNet">Art-Net</SelectItem>
                  <SelectItem value="sacn">sACN</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Field id={idOf("port")} label={t("forwarding.port")} error={msg(errors.fields.port)}>
            <Input
              id={idOf("port")}
              type="number"
              className="tabular"
              value={draft.port}
              onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
              {...invalid("port")}
            />
          </Field>
          <div className="grid gap-1.5">
            <Label>{t("forwarding.mode")}</Label>
            <Select
              value={draft.mode}
              onValueChange={(v) => patch({ mode: v as ForwardDestination["mode"] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("forwarding.modeAll")}</SelectItem>
                <SelectItem value="selected">{t("forwarding.modeSelected")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Field
            id={idOf("universeOffset")}
            label={t("forwarding.universeOffset")}
            error={msg(errors.fields.universeOffset)}
          >
            <Input
              id={idOf("universeOffset")}
              type="number"
              className="tabular"
              value={draft.universeOffset}
              onChange={(e) => patch({ universeOffset: Number(e.target.value) || 0 })}
              {...invalid("universeOffset")}
            />
          </Field>
          <Field
            id={idOf("defaultDelayMs")}
            label={t("forwarding.defaultDelay")}
            error={msg(errors.fields.defaultDelayMs)}
          >
            <Input
              id={idOf("defaultDelayMs")}
              type="number"
              className="tabular"
              value={draft.defaultDelayMs}
              onChange={(e) => patch({ defaultDelayMs: Number(e.target.value) || 0 })}
              {...invalid("defaultDelayMs")}
            />
          </Field>
          <div className="col-span-2 grid gap-1.5">
            <Label htmlFor={`${base}-description`}>{t("forwarding.description")}</Label>
            <Textarea
              id={`${base}-description`}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>
        </div>

        {/* 覆盖规则 */}
        <div className="mt-1">
          <div className="mb-2 flex items-center justify-between">
            <Label>{t("forwarding.overrides")}</Label>
            <Button variant="outline" size="sm" onClick={addOverride}>
              <Plus />
              {t("forwarding.addOverride")}
            </Button>
          </div>

          <div className="mb-2 flex items-center gap-2">
            <Input
              className="tabular"
              aria-label={t("forwarding.rangeAdd")}
              placeholder={t("forwarding.rangeAdd")}
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
            />
            <Button variant="secondary" size="sm" onClick={applyRange}>
              {t("forwarding.rangeApply")}
            </Button>
          </div>

          <div className="space-y-1.5">
            {draft.overrides.map((o, i) => {
              const oe = submitted ? errors.overrides[i] : undefined;
              const rowError = oe?.sourceUniverse ?? oe?.targetUniverse ?? oe?.delayMs;
              const rowErrorId = `${base}-override-${i}-error`;
              const ariaFor = (bad: boolean) =>
                bad ? { "aria-invalid": true, "aria-describedby": rowErrorId } : {};
              return (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="tabular w-20"
                      aria-label={t("forwarding.sourceUniverse")}
                      value={o.sourceUniverse}
                      onChange={(e) => {
                        const ov = [...draft.overrides];
                        ov[i] = { ...o, sourceUniverse: Number(e.target.value) || 0 };
                        patch({ overrides: ov });
                      }}
                      {...ariaFor(Boolean(oe?.sourceUniverse))}
                    />
                    <Select
                      value={o.action}
                      onValueChange={(v) => {
                        const ov = [...draft.overrides];
                        ov[i] = { ...o, action: v as OverrideAction };
                        patch({ overrides: ov });
                      }}
                    >
                      <SelectTrigger className="w-28" aria-label={t("forwarding.action")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="forward">{t("forwarding.actionForward")}</SelectItem>
                        <SelectItem value="exclude">{t("forwarding.actionExclude")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="tabular w-24"
                      aria-label={t("forwarding.targetUniverse")}
                      placeholder={t("forwarding.targetUniverse")}
                      value={o.targetUniverse ?? ""}
                      onChange={(e) => {
                        const ov = [...draft.overrides];
                        const val = e.target.value === "" ? null : Number(e.target.value);
                        ov[i] = { ...o, targetUniverse: val };
                        patch({ overrides: ov });
                      }}
                      {...ariaFor(Boolean(oe?.targetUniverse))}
                    />
                    <Input
                      type="number"
                      className="tabular w-20"
                      aria-label={t("forwarding.delay")}
                      placeholder={t("forwarding.delay")}
                      value={o.delayMs ?? ""}
                      onChange={(e) => {
                        const ov = [...draft.overrides];
                        const val = e.target.value === "" ? null : Number(e.target.value);
                        ov[i] = { ...o, delayMs: val };
                        patch({ overrides: ov });
                      }}
                      {...ariaFor(Boolean(oe?.delayMs))}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.delete")}
                      onClick={() =>
                        patch({ overrides: draft.overrides.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {rowError && (
                    <p id={rowErrorId} role="alert" className="mt-1 text-xs text-destructive">
                      {t(`forwarding.error.${rowError}`)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}