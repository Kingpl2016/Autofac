import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Plus, Trash2 } from "lucide-react";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MODE_KEY,
  addMode,
  blankProperty,
  layoutForKey,
  removeMode,
  withLayout,
} from "../lib/draft";
import { fixtureErrorText } from "../lib/errors";
import { headCount } from "../lib/functions";
import type { FixtureModel, FixtureProperty } from "../lib/types";
import { footprint, validateModel } from "../lib/validate";
import { ChannelStrip } from "./ChannelStrip";
import { EmitterSection, PhysicalSection } from "./editor/ModelExtras";
import { PropertyRow } from "./editor/PropertyRow";

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
  const [modeKey, setModeKey] = useState<string>(DEFAULT_MODE_KEY);
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

  const layout = layoutForKey(draft, modeKey);
  const heads = headCount(draft);
  const modes = draft.modes ?? [];
  const activeMode = modes.find((m) => m.id === modeKey);

  const patch = (changes: Partial<FixtureModel>) => setDraft((d) => ({ ...d, ...changes }));
  const setLayout = (fn: (props: FixtureProperty[]) => FixtureProperty[]) =>
    setDraft((d) => withLayout(d, modeKey, fn(layoutForKey(d, modeKey))));
  const patchRow = (index: number, changes: Partial<FixtureProperty>) =>
    setLayout((props) => props.map((p, i) => (i === index ? { ...p, ...changes } : p)));

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

  const textField = (id: string, label: string, value: string, set: (v: string) => void, extra?: { disabled?: boolean; mono?: boolean; hint?: string }) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className={extra?.mono ? "num" : undefined}
        value={value}
        disabled={extra?.disabled}
        onChange={(e) => set(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {extra?.hint && <p className="text-xs text-muted-foreground">{extra.hint}</p>}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{lockId ? t("fixtures.editor.editTitle") : t("fixtures.editor.createTitle")}</DialogTitle>
          <DialogDescription>{t("fixtures.editor.description")}</DialogDescription>
        </DialogHeader>

        <form id="fixture-form" className="grid gap-5" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid gap-4 sm:grid-cols-5">
            {textField("fx-id", t("fixtures.detail.id"), draft.id, (id) => patch({ id }), {
              disabled: lockId,
              mono: true,
              hint: t("fixtures.editor.idHint"),
            })}
            {textField("fx-name", t("fixtures.editor.name"), draft.name, (name) => patch({ name }))}
            {textField("fx-maker", t("fixtures.editor.manufacturer"), draft.manufacturer ?? "", (v) =>
              patch({ manufacturer: v || undefined }),
            )}
            {textField("fx-system", t("fixtures.detail.system"), draft.system, (system) => patch({ system }))}
            {textField("fx-type", t("fixtures.detail.productType"), draft.productType, (productType) => patch({ productType }))}
          </div>

          <Tabs defaultValue="layout">
            <TabsList>
              <TabsTrigger value="layout">{t("fixtures.editor.tabLayout")}</TabsTrigger>
              <TabsTrigger value="physical">{t("fixtures.editor.tabPhysical")}</TabsTrigger>
              <TabsTrigger value="emitters">{t("fixtures.editor.tabEmitters")}</TabsTrigger>
            </TabsList>

            <TabsContent value="layout" className="grid gap-4">
              {/* 通道模式：默认模式 + 附加模式，切换后下面编辑的就是该模式的布局 */}
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("fixtures.editor.modes")}>
                {[{ id: DEFAULT_MODE_KEY, name: draft.defaultModeName || t("fixtures.editor.defaultMode"), props: draft.properties }, ...modes.map((m) => ({ id: m.id, name: m.name || m.id, props: m.properties }))].map((m) => (
                  <Button
                    key={m.id || "__default"}
                    type="button"
                    size="sm"
                    variant={m.id === modeKey ? "default" : "outline"}
                    aria-pressed={m.id === modeKey}
                    onClick={() => setModeKey(m.id)}
                  >
                    {m.name}
                    <span className={cn("num text-xs", m.id === modeKey ? "opacity-80" : "text-muted-foreground")}>
                      {t("fixtures.editor.modeChannels", { count: footprint(m.props) })}
                    </span>
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = addMode(draft, modeKey, t("fixtures.editor.newModeName", { n: modes.length + 2 }));
                    setDraft(next.model);
                    setModeKey(next.key);
                  }}
                >
                  <Copy aria-hidden />
                  {t("fixtures.editor.addMode")}
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="fx-mode-name">{t("fixtures.editor.modeName")}</Label>
                  <Input
                    id="fx-mode-name"
                    className="w-56"
                    value={activeMode ? activeMode.name : (draft.defaultModeName ?? "")}
                    placeholder={t("fixtures.editor.defaultMode")}
                    onChange={(e) => {
                      const name = e.target.value;
                      if (activeMode) {
                        patch({ modes: modes.map((m) => (m.id === modeKey ? { ...m, name } : m)) });
                      } else {
                        patch({ defaultModeName: name || undefined });
                      }
                    }}
                  />
                </div>
                {activeMode && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft((d) => removeMode(d, modeKey));
                      setModeKey(DEFAULT_MODE_KEY);
                    }}
                  >
                    <Trash2 aria-hidden />
                    {t("fixtures.editor.removeMode")}
                  </Button>
                )}
              </div>

              <ChannelStrip model={{ properties: layout }} />

              <ul className="grid gap-2" aria-label={t("fixtures.editor.propertiesCaption")}>
                {layout.map((p, i) => (
                  <PropertyRow
                    key={i}
                    property={p}
                    row={i + 1}
                    heads={heads}
                    onChange={(changes) => patchRow(i, changes)}
                    onRemove={() => setLayout((props) => props.filter((_, j) => j !== i))}
                  />
                ))}
              </ul>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLayout((props) => [...props, blankProperty({ properties: props })])}
                >
                  <Plus aria-hidden />
                  {t("fixtures.editor.addProperty")}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="physical">
              <PhysicalSection draft={draft} onChange={patch} />
            </TabsContent>
            <TabsContent value="emitters">
              <EmitterSection draft={draft} onChange={patch} />
            </TabsContent>
          </Tabs>

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
