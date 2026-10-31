import type { TFunction } from "i18next";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { announce } from "@/shared/stores/announcerStore";
import { useSkillStore } from "../stores/useSkillStore";
import type { SkillInfo } from "./skillsApi";

/**
 * 技能库错误码的文案。
 *
 * @param t 翻译函数。
 * @param e 错误（后端错误码）。
 * @returns 文案。
 */
export function skillErrorText(t: TFunction, e: unknown): string {
  const code = errorMessage(e);
  return t(`ai.skills.errors.${code}`, { defaultValue: t("ai.skills.errors.unknown", { code }) });
}

/**
 * 看起来像技能包的路径：`.zip`、`SKILL.md`，或没有扩展名（文件夹）。
 *
 * @param path 路径。
 * @returns 是否像技能包。
 */
export function isSkillPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return /\.zip$/i.test(name) || /^skill\.md$/i.test(name) || !name.includes(".");
}

/**
 * 导入一个技能包并提示：同名已存在时在提示里询问是否替换（替换掉的进回收站）。
 *
 * @param path 路径（zip / 文件夹 / SKILL.md）。
 * @param t 翻译函数。
 * @returns 导入的技能；失败或没有替换时为 `null`。
 */
export async function importSkillWithToast(path: string, t: TFunction): Promise<SkillInfo | null> {
  const store = useSkillStore.getState();
  try {
    const info = await store.importPath(path);
    const name = info.title ?? info.name;
    toast.success(t("ai.skills.imported", { name }), { description: info.description.slice(0, 120) });
    announce(t("ai.skills.imported", { name }));
    return info;
  } catch (e) {
    if (errorMessage(e) !== "exists") {
      toast.error(skillErrorText(t, e));
      return null;
    }
    return new Promise((resolve) => {
      toast.warning(t("ai.skills.exists"), {
        action: {
          label: t("ai.skills.replace"),
          onClick: () => {
            store
              .importPath(path, true)
              .then((info) => {
                toast.success(t("ai.skills.replaced", { name: info.title ?? info.name }));
                resolve(info);
              })
              .catch((err: unknown) => {
                toast.error(skillErrorText(t, err));
                resolve(null);
              });
          },
        },
        onDismiss: () => resolve(null),
        onAutoClose: () => resolve(null),
      });
    });
  }
}
