import { useTranslation } from "react-i18next";
import { ChevronRight, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { defaultValueFor } from "../../lib/draft";
import { defaultPrecedence, groupOf } from "../../lib/functions";
import type { FixtureProperty, Precedence } from "../../lib/types";
import { CapabilityEditor } from "./CapabilityEditor";
import { FunctionSelect } from "./FunctionSelect";

interface PropertyRowProps {
  property: FixtureProperty;
  /** 行号（1 起） */
  row: number;
  /** 模型的像素头数量（0 为单头灯，此时不显示“所属像素”） */
  heads: number;
  onChange: (changes: Partial<FixtureProperty>) => void;
  onRemove: () => void;
}

/**
 * 通道对象的一行：常用字段（通道、位宽、名称、代码、功能、默认值）一直可见，
 * 高级字段（高亮值、合成规则、反向、字节序、所属像素、能力区间）收在“更多”里。
 */
export function PropertyRow({ property: p, row, heads, onChange, onRemove }: PropertyRowProps) {
  const { t } = useTranslation();
  const field = (name: string) => t("fixtures.editor.rowLabel", { n: row, field: name });
  const max = p.width === 2 ? 65535 : 255;
  const capCount = p.capabilities?.length ?? 0;

  return (
    <Collapsible className="rounded-lg border border-border bg-card" asChild>
      <li>
        <div className="grid grid-cols-[2rem_4.5rem_6.5rem_minmax(7rem,1fr)_minmax(6rem,0.8fr)_11rem_5.5rem_2.25rem] items-center gap-2 p-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="group size-8"
              aria-label={t("fixtures.editor.more", { n: row })}
            >
              <ChevronRight className="transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden />
            </Button>
          </CollapsibleTrigger>
          <Input
            className="num h-9 px-2"
            inputMode="numeric"
            aria-label={field(t("fixtures.table.channel"))}
            value={p.channel}
            onChange={(e) => onChange({ channel: Number(e.target.value) || 0 })}
          />
          <Select
            value={String(p.width)}
            onValueChange={(v) => {
              const width = v === "2" ? 2 : 1;
              onChange({ width, defaultValue: Math.min(p.defaultValue, width === 2 ? 65535 : 255), capabilities: undefined });
            }}
          >
            <SelectTrigger className="h-9 px-2" aria-label={field(t("fixtures.table.width"))}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t("fixtures.table.bits8")}</SelectItem>
              <SelectItem value="2">{t("fixtures.editor.bits16")}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-9 px-2"
            aria-label={field(t("fixtures.editor.propName"))}
            placeholder={t("fixtures.editor.propName")}
            value={p.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
          <Input
            className="num h-9 px-2"
            aria-label={field(t("fixtures.editor.propCode"))}
            placeholder={t("fixtures.editor.propCode")}
            value={p.code}
            onChange={(e) => onChange({ code: e.target.value })}
            spellCheck={false}
          />
          <FunctionSelect
            className="h-9 px-2"
            label={field(t("fixtures.table.function"))}
            value={p.function}
            onChange={(fn) => onChange({ function: fn, defaultValue: defaultValueFor(fn, p.width), precedence: undefined })}
          />
          <Input
            className="num h-9 px-2"
            inputMode="numeric"
            aria-label={field(t("fixtures.table.default"))}
            value={p.defaultValue}
            onChange={(e) => onChange({ defaultValue: Number(e.target.value) || 0 })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={t("fixtures.editor.removeRow", { n: row })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-12 pb-2 empty:hidden">
          <Badge variant="secondary">{t(`fixtures.groups.${groupOf(p.function)}`)}</Badge>
          {(p.head ?? 0) > 0 && <Badge variant="outline">{t("fixtures.editor.headBadge", { n: p.head })}</Badge>}
          {capCount > 0 && <Badge variant="outline">{t("fixtures.editor.capCount", { count: capCount })}</Badge>}
          {p.invert && <Badge variant="outline">{t("fixtures.editor.invert")}</Badge>}
        </div>
        <CollapsibleContent className="grid gap-3 border-t border-border p-3">
          <div className="flex flex-wrap items-end gap-4">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("fixtures.editor.highlight")}
              <Input
                className="num h-9 w-24 px-2"
                inputMode="numeric"
                aria-label={field(t("fixtures.editor.highlight"))}
                placeholder={String(max)}
                value={p.highlightValue ?? ""}
                onChange={(e) => onChange({ highlightValue: e.target.value === "" ? undefined : Number(e.target.value) || 0 })}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("fixtures.editor.precedence")}
              <Select
                value={p.precedence ?? "auto"}
                onValueChange={(v) => onChange({ precedence: v === "auto" ? undefined : (v as Precedence) })}
              >
                <SelectTrigger className="h-9 w-48 px-2" aria-label={field(t("fixtures.editor.precedence"))}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("fixtures.editor.precedenceAuto", { rule: t(`fixtures.editor.${defaultPrecedence(p.function)}`) })}
                  </SelectItem>
                  <SelectItem value="htp">{t("fixtures.editor.htp")}</SelectItem>
                  <SelectItem value="ltp">{t("fixtures.editor.ltp")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {heads > 0 && (
              <label className="grid gap-1 text-xs text-muted-foreground">
                {t("fixtures.editor.head")}
                <Input
                  className="num h-9 w-20 px-2"
                  inputMode="numeric"
                  aria-label={field(t("fixtures.editor.head"))}
                  value={p.head ?? 0}
                  onChange={(e) => {
                    const head = Math.max(0, Number(e.target.value) || 0);
                    onChange({ head: head === 0 ? undefined : head });
                  }}
                />
              </label>
            )}
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch
                checked={p.invert === true}
                onCheckedChange={(v) => onChange({ invert: v ? true : undefined })}
                aria-label={field(t("fixtures.editor.invert"))}
              />
              {t("fixtures.editor.invert")}
            </label>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch
                checked={p.bigEndian}
                disabled={p.width !== 2}
                onCheckedChange={(v) => onChange({ bigEndian: v })}
                aria-label={field(t("fixtures.editor.bigEndian"))}
              />
              {t("fixtures.editor.bigEndian")}
            </label>
          </div>
          <div className="grid gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("fixtures.editor.capabilities")}</p>
            <CapabilityEditor property={p} row={row} onChange={(capabilities) => onChange({ capabilities })} />
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
