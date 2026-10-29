import { toast } from "sonner";

import type { FixtureModel } from "@/features/fixtures";
import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { applyAddPlan, NAME_PLACEHOLDER, planAddFixtures, type AddFixturesOptions, type AddPlan } from "../lib/addPlan";
import { createGroup } from "../lib/ops";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 添加选项（在计划选项之外，可以加完后编为一组）。 */
export interface AddModelOptions extends AddFixturesOptions {
  /** 添加后编为一组（至少 2 台才建组） */
  group?: boolean;
}

/** 添加结果。 */
export interface AddModelResult {
  ids: string[];
  plan: AddPlan;
  /** 新建的分组 id */
  groupId: string | null;
}

/**
 * 分组名：取名称模板去掉序号占位符后的部分，空时用模型名。
 *
 * @param model 模型。
 * @param template 名称模板。
 * @returns 分组名。
 */
function groupNameOf(model: FixtureModel, template: string | undefined): string {
  const base = (template ?? "").split(NAME_PLACEHOLDER).join("").trim();
  return base || model.name;
}

/**
 * 把某个模型的若干台灯具加入当前节目（一步撤销）：按计划分配地址、创建轨道，可选编组；
 * 选中新灯具，读屏播报并弹出带“撤销”的提示。放不下任何一台时不改工程并提示原因。
 *
 * @param model 模型。
 * @param options 添加选项。
 * @returns 结果；一台都放不下时 `ids` 为空。
 */
export function addModelToShow(model: FixtureModel, options: AddModelOptions): AddModelResult {
  const store = useProjectStore.getState();
  const plan = planAddFixtures(store.project, model, options);
  if (plan.items.length === 0) {
    const text = i18n.t("editor.fixtureAdd.noRoom", { name: model.name });
    announce(text);
    toast.error(text);
    return { ids: [], plan, groupId: null };
  }
  let ids: string[] = [];
  let groupId: string | null = null;
  store.update((d) => {
    ids = applyAddPlan(d, model, plan);
    if (options.group && ids.length >= 2) groupId = createGroup(d, groupNameOf(model, options.nameTemplate), ids);
  });
  useEditorUiStore.getState().setSelectedFixtures(ids);
  // 素材库的“最近添加”（拖放、“+”、批量添加都经过这里）
  void useEditorPrefsStore.getState().noteRecentFixture(model.id);

  const first = plan.items[0];
  const parts = [i18n.t("editor.library.added", { count: ids.length, name: model.name })];
  if (plan.shifted) parts.push(i18n.t("editor.fixtureAdd.shifted", { universe: first.universe, address: first.address }));
  if (ids.length < plan.requested) parts.push(i18n.t("editor.fixtureAdd.partial", { count: plan.requested - ids.length }));
  if (groupId) parts.push(i18n.t("editor.fixtureAdd.grouped"));
  const text = parts.join(i18n.t("editor.fixtureAdd.sep"));
  announce(text);
  toast(text, {
    action: { label: i18n.t("editor.undoAction"), onClick: () => useProjectStore.temporal.getState().undo() },
  });
  return { ids, plan, groupId };
}
