import { beforeAll, describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import { fixtureErrorText } from "../errors";

beforeAll(async () => {
  await i18n.changeLanguage("zh");
});

describe("fixtureErrorText", () => {
  const t = i18n.t.bind(i18n);

  it("把后端错误码转成中文文案", () => {
    expect(fixtureErrorText(t, "builtin_readonly")).toBe("内置模型不可修改");
    expect(fixtureErrorText(t, "bad_path")).toBe("请选择一个 .xlsx 或 .json 文件");
    expect(fixtureErrorText(t, "file_too_large")).toBe("文件太大（Excel 上限 20 MB，OFL 上限 5 MB）");
    expect(fixtureErrorText(t, "import_failed:open")).toBe("无法打开或解析这个文件");
    expect(fixtureErrorText(t, "import_failed:no_models")).toBe("文件里没有找到可导入的物模型");
  });

  it("校验错误带上原因码", () => {
    expect(fixtureErrorText(t, "invalid_model:overlap")).toBe("模型未通过校验（overlap）");
  });

  it("未知错误回落到通用文案", () => {
    expect(fixtureErrorText(t, "什么鬼")).toBe("发生未知错误");
    expect(fixtureErrorText(t, undefined)).toBe("发生未知错误");
  });
});
