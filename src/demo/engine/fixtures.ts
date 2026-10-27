import type { FixtureModel } from "@/features/fixtures/lib/types";
import { fail, str, type DemoModule, type World } from "./world";

/**
 * 创建灯具素材库模块：内存里的模型列表，行为与真实后端一致 ——
 * 内置模型只读，自定义模型可新增 / 更新 / 删除，导入 Excel 返回固定的演示结果。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 灯具素材库模块（只有命令，没有周期驱动）。
 */
export function createFixturesModule(world: World): DemoModule {
  const models: FixtureModel[] = structuredClone(world.data.fixtures.models);
  const isBuiltin = (id: string) => models.some((m) => m.id === id && m.builtin);

  return {
    commands: {
      fixture_list: () => models,

      fixture_import_xlsx: (args) => {
        const path = str(args, "path").trim().toLowerCase();
        if (!path.endsWith(".xlsx")) return fail("bad_path");
        world.log("info", "演示模式：已模拟导入物模型表");
        return world.data.fixtures.importOutcome;
      },

      fixture_save: (args) => {
        const model = structuredClone(args.model as FixtureModel);
        model.id = model.id.trim();
        if (isBuiltin(model.id)) return fail("builtin_readonly");
        if (model.id === "") return fail("invalid_model:empty_id");
        if (model.name.trim() === "") return fail("invalid_model:empty_name");
        if (model.properties.length === 0) return fail("invalid_model:no_properties");
        model.builtin = false;
        const index = models.findIndex((m) => m.id === model.id);
        if (index >= 0) models[index] = model;
        else models.push(model);
        return model;
      },

      fixture_delete: (args) => {
        const id = str(args, "id");
        if (isBuiltin(id)) return fail("builtin_readonly");
        const index = models.findIndex((m) => m.id === id);
        if (index < 0) return fail("not_found");
        models.splice(index, 1);
        return undefined;
      },
    },
  };
}
