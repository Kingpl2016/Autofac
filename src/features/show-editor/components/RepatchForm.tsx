import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListOrdered } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { announce } from "@/shared/stores/announcerStore";
import { DMX_CHANNELS, MAX_UNIVERSE } from "../lib/project";
import { repatchSequential } from "../lib/universeOps";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 批量配接：把勾选的灯具从指定地址起顺序排布（按列表顺序），
 * 当前 Universe 放不下时自动换到下一个 Universe；可在相邻灯具之间留空通道。
 *
 * @param props.fixtureIds 勾选的灯具（按 Patch 列表顺序）。
 */
export function RepatchForm({ fixtureIds }: { fixtureIds: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const first = useProjectStore((s) => s.project.fixtures.find((f) => f.id === fixtureIds[0]));
  const [universe, setUniverse] = useState(String(first?.universe ?? 0));
  const [address, setAddress] = useState("1");
  const [gap, setGap] = useState("0");
  const id = useId();

  const u = Number(universe);
  const a = Number(address);
  const g = Number(gap);
  const valid =
    Number.isInteger(u) && u >= 0 && u <= MAX_UNIVERSE &&
    Number.isInteger(a) && a >= 1 && a <= DMX_CHANNELS &&
    Number.isInteger(g) && g >= 0 && g < DMX_CHANNELS;

  const apply = () => {
    if (!valid || fixtureIds.length === 0) return;
    let moved = 0;
    update((d) => {
      moved = repatchSequential(d, fixtureIds, { universe: u, address: a }, g);
    });
    announce(t("editor.patch.repatched", { count: moved, total: fixtureIds.length }));
  };

  const field = (label: string, value: string, set: (v: string) => void, suffix: string) => (
    <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={`${id}-${suffix}`}>
      {label}
      <Input
        id={`${id}-${suffix}`}
        className="num h-7 w-16 px-1.5 text-xs"
        inputMode="numeric"
        value={value}
        aria-invalid={!valid || undefined}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
      />
    </label>
  );

  return (
    <fieldset className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2">
      <legend className="px-1 text-xs text-muted-foreground">{t("editor.patch.repatchTitle")}</legend>
      {field("U", universe, setUniverse, "u")}
      {field("@", address, setAddress, "a")}
      {field(t("editor.patch.repatchGap"), gap, setGap, "g")}
      <Button type="button" size="sm" variant="secondary" className="h-7" disabled={!valid} onClick={apply}>
        <ListOrdered aria-hidden />
        {t("editor.patch.repatchApply", { count: fixtureIds.length })}
      </Button>
    </fieldset>
  );
}
