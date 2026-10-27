import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { channelCount, useFixtureStore, type FixtureModel } from "@/features/fixtures";
import { announce } from "@/shared/stores/announcerStore";
import { addFixtures, MAX_ADD_COUNT } from "../lib/ops";
import { clamp } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { EmptyHint } from "./EmptyHint";

/**
 * 素材库的“灯具”标签页：列出素材库里的灯具模型，点“添加”把若干个灯具加入节目。
 * 新灯具会自动分配 DMX 地址、各自生成一条轨道，并被选中以便立刻编组或改名。
 */
export function LibraryFixturesTab() {
  const { t } = useTranslation();
  const models = useFixtureStore((s) => s.models);
  const status = useFixtureStore((s) => s.status);
  const load = useFixtureStore((s) => s.load);
  const update = useProjectStore((s) => s.update);
  const setSelectedFixtures = useEditorUiStore((s) => s.setSelectedFixtures);
  const [quantity, setQuantity] = useState("1");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const count = clamp(Math.floor(Number(quantity)) || 1, 1, MAX_ADD_COUNT);

  const add = (model: FixtureModel) => {
    let ids: string[] = [];
    update((draft) => {
      ids = addFixtures(draft, model, count);
    });
    setSelectedFixtures(ids);
    announce(t("editor.library.added", { count: ids.length, name: model.name }));
  };

  if (status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-sm">
        <p role="alert" className="text-destructive">{t("editor.library.loadFailed")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          {t("fixtures.retry")}
        </Button>
      </div>
    );
  }
  if (models.length === 0) {
    return <EmptyHint>{status === "loading" ? t("common.loading") : t("editor.library.noFixtures")}</EmptyHint>;
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2 px-1">
        <Label htmlFor="add-quantity" className="text-xs text-muted-foreground">
          {t("editor.library.quantity")}
        </Label>
        <Input
          id="add-quantity"
          className="num h-8 w-16 px-2"
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          onBlur={() => setQuantity(String(count))}
        />
      </div>
      <ul className="flex flex-col gap-1">
        {models.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{m.name}</span>
              <span className="num block truncate text-xs text-muted-foreground">
                {m.id} · {t("fixtures.list.channels", { count: channelCount(m) })}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("editor.library.addAria", { name: m.name, count })}
              title={t("editor.library.addAria", { name: m.name, count })}
              onClick={() => add(m)}
            >
              <Plus aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
