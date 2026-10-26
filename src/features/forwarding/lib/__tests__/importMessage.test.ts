// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import { describeImportError } from "../importMessage";

const t = i18n.t.bind(i18n);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("describeImportError", () => {
  it("结构性错误", () => {
    expect(describeImportError({ kind: "json" }, t)).toContain("不是有效的 JSON");
    expect(describeImportError({ kind: "shape" }, t)).toContain("目的地数组");
    expect(describeImportError({ kind: "empty" }, t)).toContain("没有任何目的地");
  });

  it("条目错误指明序号、字段名与原因", () => {
    const msg = describeImportError(
      { kind: "item", index: 3, field: "targetIp", code: "ipInvalid" },
      t,
    );
    expect(msg).toContain("第 3 个");
    expect(msg).toContain("目标 IP");
    expect(msg).toContain("IPv4");
  });

  it("覆盖规则字段 overrides[2] 归并为“Universe 覆盖”", () => {
    const msg = describeImportError(
      { kind: "item", index: 1, field: "overrides[2]", code: "overrideSource" },
      t,
    );
    expect(msg).toContain("Universe 覆盖");
  });

  it("未知字段退回原始字段标识；英文界面使用英文", async () => {
    expect(
      describeImportError({ kind: "item", index: 1, field: "weird", code: "typeInvalid" }, t),
    ).toContain("weird");
    await i18n.changeLanguage("en");
    expect(describeImportError({ kind: "json" }, i18n.t.bind(i18n))).toContain("not valid JSON");
  });
});