import { useTranslation } from "react-i18next";
import { Copy, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { sortByChannel } from "../lib/draft";
import { channelRangeText } from "../lib/format";
import type { FixtureModel } from "../lib/types";
import { channelCount } from "../lib/validate";
import { ChannelStrip } from "./ChannelStrip";

interface FixtureDetailProps {
  model: FixtureModel;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}

/** 右侧详情：模型信息、通道布局条和属性表。内置模型只读，只能“复制为自定义”。 */
export function FixtureDetail({ model, onEdit, onClone, onDelete }: FixtureDetailProps) {
  const { t } = useTranslation();
  const props = sortByChannel(model.properties);
  return (
    <SurfacePanel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base">{model.name}</span>
          <Badge variant={model.builtin ? "secondary" : "default"}>
            {model.builtin ? t("fixtures.detail.builtin") : t("fixtures.detail.custom")}
          </Badge>
        </span>
      }
      actions={
        <>
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
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Meta label={t("fixtures.detail.id")} value={model.id} mono />
        <Meta label={t("fixtures.detail.system")} value={model.system || "—"} />
        <Meta label={t("fixtures.detail.productType")} value={model.productType || "—"} />
        <Meta
          label={t("fixtures.detail.channelCount")}
          value={String(channelCount(model))}
          mono
        />
      </dl>

      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t("fixtures.detail.layout")}
      </h3>
      <ChannelStrip model={model} />

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
              <th scope="col" className="py-2 font-medium">{t("fixtures.table.values")}</th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={`${p.channel}-${p.code}`} className="border-b border-border/60 align-top">
                <td className="num py-2 pr-3">{channelRangeText(p.channel, p.width)}</td>
                <td className="py-2 pr-3">
                  <span className="font-medium">{p.name || p.code}</span>
                  {p.name && p.code && p.name !== p.code && (
                    <span className="num ml-2 text-xs text-muted-foreground">{p.code}</span>
                  )}
                </td>
                <td className="py-2 pr-3">{t(`fixtures.functions.${p.function}`)}</td>
                <td className="py-2 pr-3">
                  {p.width === 2
                    ? t("fixtures.table.bits16", {
                        order: p.bigEndian ? t("fixtures.table.bigEndian") : t("fixtures.table.littleEndian"),
                      })
                    : t("fixtures.table.bits8")}
                </td>
                <td className="num py-2 pr-3">{p.defaultValue}</td>
                <td className="py-2 text-muted-foreground">{p.valueDesc || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfacePanel>
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
