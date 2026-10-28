import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ListPlus, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/shared/components/Segmented";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { DEFAULT_MODE_KEY, layoutForKey, sortByChannel } from "../lib/draft";
import { channelRangeText } from "../lib/format";
import { effectivePrecedence, groupOf, headCount } from "../lib/functions";
import { FIXTURE_CAPABILITIES, modelProfile, modelType, type FixtureCapability } from "../lib/profile";
import type { FixtureModel } from "../lib/types";
import { footprint } from "../lib/validate";
import { ChannelStrip } from "./ChannelStrip";
import { CapabilityBand } from "./editor/CapabilityEditor";
import { FixtureTypeIcon } from "./FixtureTypeIcon";

interface FixtureDetailProps {
  model: FixtureModel;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
  /** 把这个模型加到节目编辑器的当前节目（跳转过去并展开批量添加）；省略时不显示按钮 */
  onAddToShow?: () => void;
}

/**
 * 模型所有模式的能力并集（徽标用：只要某个模式能做就列出）。
 *
 * @param model 模型。
 * @returns 按固定顺序的能力。
 */
function modelCapabilities(model: FixtureModel): FixtureCapability[] {
  const all = new Set<FixtureCapability>();
  for (const id of [undefined, ...(model.modes ?? []).map((m) => m.id)]) {
    for (const c of modelProfile(model, id).caps) all.add(c);
  }
  return FIXTURE_CAPABILITIES.filter((c) => all.has(c));
}

/**
 * 右侧详情：头部（类型图标、名称、来源与能力徽标、操作）、关键参数卡片、通道模式切换、
 * 按功能组着色的通道布局条与图例、通道对象表。内置模型只读，只能“复制为自定义”。
 */
export function FixtureDetail({ model, onEdit, onClone, onDelete, onAddToShow }: FixtureDetailProps) {
  const { t } = useTranslation();
  const [modeKey, setModeKey] = useState(DEFAULT_MODE_KEY);
  const modes = model.modes ?? [];
  // 切换到别的模型后，若原模式不存在则回到默认模式
  const key = modeKey === DEFAULT_MODE_KEY || modes.some((m) => m.id === modeKey) ? modeKey : DEFAULT_MODE_KEY;
  const layout = layoutForKey(model, key);
  const props = sortByChannel(layout);
  const hasCaps = layout.some((p) => (p.capabilities?.length ?? 0) > 0);
  const type = modelType(model);
  const caps = modelCapabilities(model);
  const heads = headCount(model);
  const phys = model.physical;
  const range = (a?: number, b?: number) => (a !== undefined && b !== undefined ? `${a}°–${b}°` : null);

  const params: { label: string; value: string; mono?: boolean }[] = [
    { label: t("fixtures.detail.channelCount"), value: String(footprint(layout)), mono: true },
    { label: t("fixtures.detail.modeCount"), value: String(1 + modes.length), mono: true },
    ...(heads > 0 ? [{ label: t("fixtures.detail.heads"), value: String(heads), mono: true }] : []),
    ...(phys?.panRangeDeg ? [{ label: t("fixtures.detail.pan"), value: `${phys.panRangeDeg}°`, mono: true }] : []),
    ...(phys?.tiltRangeDeg ? [{ label: t("fixtures.detail.tilt"), value: `${phys.tiltRangeDeg}°`, mono: true }] : []),
    ...(range(phys?.beamMinDeg, phys?.beamMaxDeg) ? [{ label: t("fixtures.detail.beam"), value: range(phys?.beamMinDeg, phys?.beamMaxDeg) ?? "", mono: true }] : []),
  ];

  return (
    <SurfacePanel
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <FixtureTypeIcon type={type} className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-base">{model.name}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={model.builtin ? "secondary" : "default"}>
                {model.builtin ? t("fixtures.detail.builtin") : t("fixtures.detail.custom")}
              </Badge>
              <Badge variant="outline">{t(`fixtures.type.${type}`)}</Badge>
              {model.matrix && <Badge variant="outline">{t("fixtures.detail.matrix", { cols: model.matrix.cols, rows: model.matrix.rows })}</Badge>}
              <span className="num text-xs font-normal text-muted-foreground">{model.id}</span>
            </span>
          </span>
        </span>
      }
      actions={
        <>
          {onAddToShow && (
            <Button type="button" size="sm" onClick={onAddToShow}>
              <ListPlus aria-hidden />
              {t("fixtures.detail.addToShow")}
            </Button>
          )}
          {!model.builtin && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              <Pencil aria-hidden />
              {t("common.edit")}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onClone}>
            <Copy aria-hidden />
            {t("fixtures.detail.clone")}
          </Button>
          {!model.builtin && (
            <Button type="button" variant="outline" size="sm" onClick={onDelete}>
              <Trash2 aria-hidden />
              {t("common.delete")}
            </Button>
          )}
        </>
      }
    >
      {caps.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-1.5" aria-label={t("fixtures.detail.capabilities")}>
          {caps.map((c) => (
            <li key={c} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-foreground">
              {t(`fixtures.cap.${c}`)}
            </li>
          ))}
        </ul>
      )}

      <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {params.map((p) => (
          <ParamCard key={p.label} label={p.label} mono={p.mono}>
            {p.value}
          </ParamCard>
        ))}
      </dl>
      <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Meta label={t("fixtures.detail.id")} value={model.id} mono />
        <Meta label={t("fixtures.detail.system")} value={model.system || "—"} />
        <Meta label={t("fixtures.detail.productType")} value={model.productType || "—"} />
        {model.manufacturer && <Meta label={t("fixtures.editor.manufacturer")} value={model.manufacturer} />}
      </dl>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{t("fixtures.detail.layout")}</h3>
        {modes.length > 0 && (
          <Segmented
            size="xs"
            ariaLabel={t("fixtures.editor.modes")}
            value={key}
            onChange={setModeKey}
            options={[{ id: DEFAULT_MODE_KEY, name: model.defaultModeName || t("fixtures.editor.defaultMode") }, ...modes].map((m) => ({
              value: m.id,
              label: m.name || m.id,
            }))}
          />
        )}
      </div>
      <ChannelStrip model={{ properties: layout }} />

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">{t("fixtures.detail.propertiesCaption", { name: model.name })}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">{t("fixtures.table.channel")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("fixtures.table.name")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("fixtures.table.function")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("fixtures.table.width")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("fixtures.table.default")}</th>
              <th scope="col" className="py-2 font-medium">{hasCaps ? t("fixtures.editor.capabilities") : t("fixtures.table.values")}</th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={`${p.channel}-${p.code}`} className="border-b border-border/60 align-top hover:bg-surface-1">
                <td className="num py-2 pr-3">{channelRangeText(p.channel, p.width)}</td>
                <td className="py-2 pr-3">
                  <span className="font-medium">{p.name || p.code}</span>
                  {p.name && p.code && p.name !== p.code && <span className="num ml-2 text-xs text-muted-foreground">{p.code}</span>}
                  {(p.head ?? 0) > 0 && (
                    <Badge variant="outline" className="ml-2">
                      {t("fixtures.editor.headBadge", { n: p.head })}
                    </Badge>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {t(`fixtures.functions.${p.function}`)}
                  <span className="block text-xs text-muted-foreground">
                    {t(`fixtures.groups.${groupOf(p.function)}`)} · {t(`fixtures.editor.${effectivePrecedence(p)}`)}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  {p.width === 2
                    ? t("fixtures.table.bits16", { order: p.bigEndian ? t("fixtures.table.bigEndian") : t("fixtures.table.littleEndian") })
                    : t("fixtures.table.bits8")}
                </td>
                <td className="num py-2 pr-3">{p.defaultValue}</td>
                <td className="min-w-48 py-2 text-muted-foreground">
                  {p.capabilities && p.capabilities.length > 0 ? (
                    <>
                      <CapabilityBand caps={p.capabilities} max={p.width === 2 ? 65535 : 255} className="h-5" />
                      <span className="sr-only">{p.capabilities.map((c) => `${c.range[0]}–${c.range[1]} ${c.label}`).join("；")}</span>
                    </>
                  ) : (
                    p.valueDesc || "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfacePanel>
  );
}

/** 关键参数卡片。 */
function ParamCard({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "num text-lg leading-tight font-semibold" : "text-lg leading-tight font-semibold"}>{children}</dd>
    </div>
  );
}

/** 详情头部的一项键值。 */
function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "num font-medium" : "font-medium"}>{value}</dd>
    </div>
  );
}
