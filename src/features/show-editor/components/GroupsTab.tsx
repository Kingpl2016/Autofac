import { useTranslation } from "react-i18next";
import { FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { announce } from "@/shared/stores/announcerStore";
import { createGroup } from "../lib/ops";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { GroupList } from "./GroupList";

/**
 * 素材库的“分组”分区：把勾选的灯具建成分组（分组轨道上的片段作用于全部成员），
 * 管理成员顺序（决定分布 / 特效推进的先后）。
 */
export function GroupsTab() {
  const { t } = useTranslation();
  const selected = useEditorUiStore((s) => s.selectedFixtureIds);
  const update = useProjectStore((s) => s.update);

  const group = () => {
    let id: string | null = null;
    update((d) => {
      id = createGroup(d, t("editor.patch.defaultGroupName", { n: d.groups.length + 1 }), selected);
    });
    if (id) announce(t("editor.patch.grouped", { count: selected.length }));
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="justify-start"
        disabled={selected.length === 0}
        title={selected.length === 0 ? t("editor.groups.needSelection") : undefined}
        onClick={group}
      >
        <FolderPlus aria-hidden />
        {t("editor.groups.fromSelection", { count: selected.length })}
      </Button>
      <GroupList />
    </div>
  );
}
