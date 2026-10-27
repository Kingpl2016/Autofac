import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { blankProperty, defaultValueFor } from "../lib/draft";
import { fixtureErrorText } from "../lib/errors";
import {
  CHANNEL_FUNCTIONS,
  type ChannelFunction,
  type FixtureModel,
  type FixtureProperty,
} from "../lib/types";
import { validateModel } from "../lib/validate";

interface FixtureEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 初始内容：新建时是空白模型，编辑 / 复制时是现有模型的副本。 */
  initial: FixtureModel;
  /** 编辑已有模型时编号不可改（编号是模型的身份）。 */
  lockId: boolean;
  /** 已被占用的模型编号（新建 / 复制时用于防重复）。 */
  takenIds: readonly string[];
  /** 保存；失败时 reject 后端错误码。 */
  onSave: (model: FixtureModel) => Promise<void>;
}

/**
 * 新建 / 编辑自定义灯具模型对话框。
 *
 * 每次打开都是全新实例（外层不渲染则不挂载），表单状态用初值初始化，不靠 effect 重置。
 */
export function FixtureEditorDialog(props: FixtureEditorDialogProps) {
  if (!props.open) return null;
  return <FixtureEditor {...props} />;
}

function FixtureEditor({ onOpenChange, initial, lockId, takenIds, onSave }: FixtureEditorDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FixtureModel>(initial);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const idTaken = !lockId && takenIds.includes(draft.id.trim());
  const issue = validateModel(draft);
  const issueText = idTaken
    ? t("fixtures.validation.idTaken")
    : issue
      ? t(`fixtures.validation.${issue.code}`, issue.params)
      : null;

  const patch = (changes: Partial<FixtureModel>) => setDraft((d) => ({ ...d, ...changes }));
  const patchRow = (index: number, changes: Partial<FixtureProperty>) =>
    setDraft((d) => ({
      ...d,
      properties: d.properties.map((p, i) => (i === index ? { ...p, ...changes } : p)),
    }));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSubmitted(true);
    if (issueText) return;
    setSaving(true);
    setServerError(null);
    try {
      await onSave({ ...draft, id: draft.id.trim(), name: draft.name.trim() });
      onOpenChange(false);
    } catch (e) {
      setServerError(fixtureErrorText(t, e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{lockId ? t("fixtures.editor.editTitle") : t("fixtures.editor.createTitle")}</DialogTitle>
          <DialogDescription>{t("fixtures.editor.description")}</DialogDescription>
        </DialogHeader>

        <form id="fixture-form" className="grid gap-5" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-1.5">
              <Label htmlFor="fx-id">{t("fixtures.detail.id")}</Label>
              <Input
                id="fx-id"
                className="num"
                value={draft.id}
                disabled={lockId}
                onChange={(e) => patch({ id: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t("fixtures.editor.idHint")}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fx-name">{t("fixtures.editor.name")}</Label>
              <Input id="fx-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} autoComplete="off" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fx-system">{t("fixtures.detail.system")}</Label>
              <Input id="fx-system" value={draft.system} onChange={(e) => patch({ system: e.target.value })} autoComplete="off" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fx-type">{t("fixtures.detail.productType")}</Label>
              <Input id="fx-type" value={draft.productType} onChange={(e) => patch({ productType: e.target.value })} autoComplete="off" />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">{t("fixtures.editor.propertiesCaption")}</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-20 pb-2 pr-2 font-medium">{t("fixtures.table.channel")}</th>
                  <th scope="col" className="w-24 pb-2 pr-2 font-medium">{t("fixtures.table.width")}</th>
                  <th scope="col" className="pb-2 pr-2 font-medium">{t("fixtures.editor.propName")}</th>
                  <th scope="col" className="pb-2 pr-2 font-medium">{t("fixtures.editor.propCode")}</th>
                  <th scope="col" className="w-44 pb-2 pr-2 font-medium">{t("fixtures.table.function")}</th>
                  <th scope="col" className="w-24 pb-2 pr-2 font-medium">{t("fixtures.editor.bigEndian")}</th>
                  <th scope="col" className="w-24 pb-2 pr-2 font-medium">{t("fixtures.table.default")}</th>
                  <th scope="col" className="w-10 pb-2"><span className="sr-only">{t("common.delete")}</span></th>
                </tr>
              </thead>
              <tbody>
                {draft.properties.map((p, i) => (
                  <tr key={i} className="align-middle">
                    <td className="pb-2 pr-2">
                      <Input
                        className="num h-9 px-2"
                        inputMode="numeric"
                        aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.table.channel") })}
                        value={p.channel}
                        onChange={(e) => patchRow(i, { channel: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td className="pb-2 pr-2">
                      <Select
                        value={String(p.width)}
                        onValueChange={(v) => {
                          const width = v === "2" ? 2 : 1;
                          patchRow(i, {
                            width,
                            defaultValue: Math.min(p.defaultValue, width === 2 ? 65535 : 255),
                          });
                        }}
                      >
                        <SelectTrigger
                          className="h-9 px-2"
                          aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.table.width") })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">{t("fixtures.table.bits8")}</SelectItem>
                          <SelectItem value="2">{t("fixtures.editor.bits16")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="pb-2 pr-2">
                      <Input
                        className="h-9 px-2"
                        aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.editor.propName") })}
                        value={p.name}
                        onChange={(e) => patchRow(i, { name: e.target.value })}
                      />
                    </td>
                    <td className="pb-2 pr-2">
                      <Input
                        className="num h-9 px-2"
                        aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.editor.propCode") })}
                        value={p.code}
                        onChange={(e) => patchRow(i, { code: e.target.value })}
                        spellCheck={false}
                      />
                    </td>
                    <td className="pb-2 pr-2">
                      <Select
                        value={p.function}
                        onValueChange={(v) => {
                          const fn = v as ChannelFunction;
                          patchRow(i, { function: fn, defaultValue: defaultValueFor(fn, p.width) });
                        }}
                      >
                        <SelectTrigger
                          className="h-9 px-2"
                          aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.table.function") })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CHANNEL_FUNCTIONS.map((fn) => (
                            <SelectItem key={fn} value={fn}>
                              {t(`fixtures.functions.${fn}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="pb-2 pr-2">
                      <Switch
                        checked={p.bigEndian}
                        disabled={p.width !== 2}
                        onCheckedChange={(v) => patchRow(i, { bigEndian: v })}
                        aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.editor.bigEndian") })}
                      />
                    </td>
                    <td className="pb-2 pr-2">
                      <Input
                        className="num h-9 px-2"
                        inputMode="numeric"
                        aria-label={t("fixtures.editor.rowLabel", { n: i + 1, field: t("fixtures.table.default") })}
                        value={p.defaultValue}
                        onChange={(e) => patchRow(i, { defaultValue: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td className="pb-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-9"
                        aria-label={t("fixtures.editor.removeRow", { n: i + 1 })}
                        onClick={() =>
                          setDraft((d) => ({ ...d, properties: d.properties.filter((_, j) => j !== i) }))
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDraft((d) => ({ ...d, properties: [...d.properties, blankProperty(d)] }))}
            >
              <Plus aria-hidden />
              {t("fixtures.editor.addProperty")}
            </Button>
          </div>

          {submitted && issueText && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {issueText}
            </p>
          )}
          {serverError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {serverError}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="fixture-form" disabled={saving}>
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
