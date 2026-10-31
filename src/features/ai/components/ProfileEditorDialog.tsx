import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCommand } from "@/shared/hooks/useCommand";
import { AI_PROFILES_KEY } from "../hooks/useAiProfiles";
import { aiKeySet, aiProfileSave } from "../lib/api";
import { aiErrorText } from "../lib/errors";
import { inputFromPreset, presetForUrl, PROVIDER_PRESETS } from "../lib/presets";
import { ModelCombobox } from "./ModelCombobox";
import type { AiModality, AiProfileInput, AiProfileView, AiProviderKind } from "../lib/types";

/** 表单的前端校验（与后端规则一致，后端仍会再校验一次）。 */
const formSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().trim().min(1).max(128),
  name: z.string().trim().max(40),
  temperature: z.number().min(0).max(2),
  seed: z.number().int().min(0).max(0xffff_ffff).nullable().optional(),
});

const KINDS: readonly AiProviderKind[] = ["openaiCompatible", "anthropic", "google"];
const MODALITIES: readonly AiModality[] = ["image", "audio"];

interface ProfileEditorDialogProps {
  /** 要编辑的配置；`null` 为新建。 */
  profile: AiProfileView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存成功（新建时可据此设为默认）。 */
  onSaved?: (saved: AiProfileView) => void;
}

/** 由已有配置得到表单初值。 */
function initialInput(profile: AiProfileView | null): AiProfileInput {
  if (!profile) return inputFromPreset(PROVIDER_PRESETS[0]);
  const { id, name, kind, baseUrl, model, supportsStructuredOutputs, inputModalities, temperature, seed } = profile;
  return { id, name, kind, baseUrl, model, supportsStructuredOutputs, inputModalities: [...(inputModalities ?? [])], temperature, seed: seed ?? null };
}

/**
 * 新建 / 编辑 AI 配置：预设、协议、接口地址、模型、API Key 与生成参数。
 * Key 只写不读：已保存时输入框留空表示保持不变。
 */
export function ProfileEditorDialog({ profile, open, onOpenChange, onSaved }: ProfileEditorDialogProps) {
  const { t } = useTranslation();
  const ids = useId();
  const [input, setInput] = useState<AiProfileInput>(() => initialInput(profile));
  const [presetId, setPresetId] = useState<string>(PROVIDER_PRESETS[0].id);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  // 建议的模型：按接口地址认出的服务优先（编辑已有配置、手改地址时也对得上），其次是选中的预设
  const suggested = (presetForUrl(input.baseUrl) ?? PROVIDER_PRESETS.find((p) => p.id === presetId))?.models ?? [];
  const parsed = formSchema.safeParse(input);
  const set = (patch: Partial<AiProfileInput>) => setInput((prev) => ({ ...prev, ...patch }));

  const save = useCommand<void>({
    run: async () => {
      const saved = await aiProfileSave(input);
      if (key.trim() !== "" || clearKey) await aiKeySet(saved.id, clearKey ? "" : key);
      onSaved?.({ ...saved, hasKey: clearKey ? false : key.trim() !== "" || saved.hasKey });
      onOpenChange(false);
    },
    success: t("ai.settings.saved"),
    describe: (e) => aiErrorText(t, e),
    invalidate: [AI_PROFILES_KEY],
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{profile ? t("ai.settings.editTitle") : t("ai.settings.addTitle")}</DialogTitle>
          <DialogDescription>{t("ai.settings.editorHint")}</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.success) void save.run();
          }}
        >
          {!profile && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-preset`}>{t("ai.settings.preset")}</Label>
              <Select
                value={presetId}
                onValueChange={(id) => {
                  setPresetId(id);
                  const p = PROVIDER_PRESETS.find((x) => x.id === id);
                  if (p) setInput(inputFromPreset(p));
                }}
              >
                <SelectTrigger id={`${ids}-preset`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {t(`ai.presets.${p.id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-name`}>{t("ai.settings.name")}</Label>
              <Input
                id={`${ids}-name`}
                value={input.name}
                maxLength={40}
                placeholder={input.model}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-kind`}>{t("ai.settings.kind")}</Label>
              <Select value={input.kind} onValueChange={(v) => set({ kind: v as AiProviderKind })}>
                <SelectTrigger id={`${ids}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`ai.kinds.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-url`}>{t("ai.settings.baseUrl")}</Label>
            <Input
              id={`${ids}-url`}
              value={input.baseUrl}
              spellCheck={false}
              aria-invalid={!parsed.success && parsed.error.issues.some((i) => i.path[0] === "baseUrl")}
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-model`}>{t("ai.settings.model")}</Label>
            <ModelCombobox
              id={`${ids}-model`}
              value={input.model}
              onChange={(model) => set({ model })}
              suggested={suggested}
              query={{
                kind: input.kind,
                baseUrl: input.baseUrl,
                profileId: profile?.id ?? null,
                // 清除 Key 时不再用已保存的 Key；表单里刚填的优先
                key: clearKey ? "" : key.trim() || null,
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-key`}>{t("ai.settings.apiKey")}</Label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                disabled={clearKey}
                placeholder={profile?.hasKey ? t("ai.settings.keyKeep") : t("ai.settings.keyEmpty")}
                onChange={(e) => setKey(e.target.value)}
              />
              {profile?.hasKey && (
                <Button type="button" variant="outline" size="sm" onClick={() => setClearKey((v) => !v)}>
                  {clearKey ? t("ai.settings.keyUndoClear") : t("ai.settings.keyClear")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("ai.settings.keyHint")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-temp`}>{t("ai.settings.temperature")}</Label>
              <Input
                id={`${ids}-temp`}
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="tabular"
                value={input.temperature}
                onChange={(e) => set({ temperature: Number(e.target.value) })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-seed`}>{t("ai.settings.seed")}</Label>
              <Input
                id={`${ids}-seed`}
                type="number"
                min={0}
                step={1}
                className="tabular"
                value={input.seed ?? ""}
                placeholder={t("ai.settings.seedNone")}
                onChange={(e) => set({ seed: e.target.value === "" ? null : Math.trunc(Number(e.target.value)) })}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{t("ai.settings.consistencyHint")}</p>

          {input.kind === "openaiCompatible" && (
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                <span className="font-medium">{t("ai.settings.structured")}</span>
                <span className="block text-xs text-muted-foreground">{t("ai.settings.structuredHint")}</span>
              </span>
              <Switch
                checked={input.supportsStructuredOutputs}
                onCheckedChange={(v) => set({ supportsStructuredOutputs: v })}
              />
            </label>
          )}

          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">{t("ai.settings.modalities")}</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {MODALITIES.map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <Switch
                    checked={input.inputModalities.includes(m)}
                    onCheckedChange={(on) => set({ inputModalities: on ? [...input.inputModalities.filter((x) => x !== m), m] : input.inputModalities.filter((x) => x !== m) })}
                  />
                  {t(`ai.settings.modality.${m}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("ai.settings.modalitiesHint")}</p>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!parsed.success} loading={save.pending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
