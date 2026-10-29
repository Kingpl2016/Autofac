import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  moveGroupMember,
  removeGroup,
  removeGroupMember,
  renameGroup,
} from "../lib/ops";
import { refName } from "../lib/fixtureRef";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/**
 * 分组列表：重命名、调整成员顺序、移出成员、删除分组。
 * 顺序决定特效沿灯具推进的先后，所以顺序用“上移 / 下移”按钮调整（键盘也能操作）。
 */
export function GroupList() {
  const { t } = useTranslation();
  const groups = useProjectStore((s) => s.project.groups);
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const update = useProjectStore((s) => s.update);
  const selectedGroupId = useEditorUiStore((s) => s.selectedGroupId);
  const selectGroup = useEditorUiStore((s) => s.selectGroup);

  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("editor.patch.noGroups")}</p>;
  }
  const nameOf = (id: string) => refName({ fixtures }, id) || id;

  return (
    <ul className="flex flex-col gap-2">
      {groups.map((g) => (
        <li
          key={g.id}
          className={cn(
            "rounded-md border bg-card p-2",
            g.id === selectedGroupId ? "border-primary" : "border-border",
          )}
        >
          <div className="flex items-center gap-2">
            <CommitInput
              className="h-8 px-2 text-sm font-medium"
              label={t("editor.patch.groupName")}
              value={g.name}
              onCommit={(name) => update((d) => renameGroup(d, g.id, name))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("editor.patch.deleteGroup", { name: g.name })}
              title={t("editor.patch.deleteGroup", { name: g.name })}
              onClick={() => {
                update((d) => removeGroup(d, g.id));
                if (selectedGroupId === g.id) selectGroup(null);
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("editor.patch.members", { count: g.fixtureIds.length })}
          </p>
          <ol className="mt-1 flex flex-col gap-0.5">
            {g.fixtureIds.map((id, index) => (
              <li key={id} className="flex items-center gap-1 text-sm">
                <span className="num w-6 shrink-0 text-right text-xs text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={index === 0}
                  aria-label={t("editor.patch.moveUp", { name: nameOf(id) })}
                  onClick={() => update((d) => moveGroupMember(d, g.id, index, index - 1))}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={index === g.fixtureIds.length - 1}
                  aria-label={t("editor.patch.moveDown", { name: nameOf(id) })}
                  onClick={() => update((d) => moveGroupMember(d, g.id, index, index + 1))}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("editor.patch.removeMember", { name: nameOf(id) })}
                  onClick={() => update((d) => removeGroupMember(d, g.id, id))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}
