// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import {
  EMPTY_PRESET,
  buildStartArgs,
  describePreset,
  hasIndexPlaceholder,
  isPresetFiltered,
  parseUniverseToken,
  presetExtraUniverses,
  presetToFilter,
  renderNameTemplate,
  sanitizePreset,
  splitUniverseInput,
  type RecordingPreset,
} from "../recordingPreset";

const preset = (over: Partial<RecordingPreset> = {}): RecordingPreset => ({ ...EMPTY_PRESET, ...over });

describe("parseUniverseToken", () => {
  it("接受单个编号与范围，反向范围自动交换", () => {
    expect(parseUniverseToken("10")).toEqual({ ok: true, label: "10", range: { start: 10, end: 10 } });
    expect(parseUniverseToken(" 3 - 0 ")).toEqual({ ok: true, label: "0-3", range: { start: 0, end: 3 } });
    expect(parseUniverseToken("4~4")).toMatchObject({ ok: true, label: "4" });
  });

  it("语法错误与起点越界分别报告原因；终点越界截到 2047", () => {
    expect(parseUniverseToken("abc")).toEqual({ ok: false, reason: "syntax" });
    expect(parseUniverseToken("1-")).toEqual({ ok: false, reason: "syntax" });
    expect(parseUniverseToken("2500")).toEqual({ ok: false, reason: "outOfRange" });
    expect(parseUniverseToken("2000-3000")).toMatchObject({ ok: true, label: "2000-2047" });
  });

  it("粘贴内容按逗号 / 空白 / 中文逗号拆分", () => {
    expect(splitUniverseInput("0-3, 10，abc  5")).toEqual(["0-3", "10", "abc", "5"]);
  });
});

describe("名称模板", () => {
  it("{n} / {nn} / {nnn} 按位数补零，空模板结果为空", () => {
    expect(renderNameTemplate("舞台A-{nn}", 4)).toBe("舞台A-04");
    expect(renderNameTemplate("{nnn}_{n}", 7)).toBe("007_7");
    expect(renderNameTemplate("彩排", 3)).toBe("彩排");
    expect(renderNameTemplate("  ", 3)).toBe("");
  });

  it("识别是否含序号占位符", () => {
    expect(hasIndexPlaceholder("A-{n}")).toBe(true);
    expect(hasIndexPlaceholder("A-{nnnn}")).toBe(false);
    expect(hasIndexPlaceholder("A")).toBe(false);
  });
});

describe("presetToFilter / buildStartArgs", () => {
  it("默认预设等价于全量采集", () => {
    expect(presetToFilter(EMPTY_PRESET, true)).toEqual({
      sources: [],
      excludeSources: false,
      universes: [],
      protocols: [],
    });
    expect(isPresetFiltered(EMPTY_PRESET, true)).toBe(false);
  });

  it("sACN 关闭时协议一律不限制，开启时只保留所选协议", () => {
    const p = preset({ protocols: ["sacn"] });
    expect(presetToFilter(p, false).protocols).toEqual([]);
    expect(presetToFilter(p, true).protocols).toEqual(["sacn"]);
    expect(isPresetFiltered(p, false)).toBe(false);
    expect(isPresetFiltered(p, true)).toBe(true);
  });

  it("额外 Universe 只会多录，不算过滤", () => {
    const p = preset({ extraTokens: ["5", "8-9"] });
    expect(presetExtraUniverses(p)).toEqual([5, 8, 9]);
    expect(isPresetFiltered(p, true)).toBe(false);
  });

  it("按模板与序号生成名称和文件名，备注去掉首尾空白", () => {
    const p = preset({
      sources: ["10.0.0.1"],
      excludeSources: true,
      universeTokens: ["0-3", "10"],
      nameTemplate: "舞台A-{nn}",
      nextIndex: 4,
    });
    const args = buildStartArgs(p, {
      now: new Date(2026, 9, 27, 9, 5, 7),
      notes: "  第一场 ",
      sacnEnabled: false,
    });
    expect(args).toEqual({
      name: "舞台A-04",
      notes: "第一场",
      fileStem: "20261027-090507_舞台A-04",
      filter: {
        sources: ["10.0.0.1"],
        excludeSources: true,
        universes: [
          { start: 0, end: 3 },
          { start: 10, end: 10 },
        ],
        protocols: [],
      },
      universes: [],
    });
  });

  it("名称为空时文件名只用时间戳", () => {
    const args = buildStartArgs(EMPTY_PRESET, { now: new Date(2026, 0, 2, 3, 4, 5), sacnEnabled: true });
    expect(args.name).toBe("");
    expect(args.fileStem).toBe("20260102-030405");
  });
});

describe("describePreset", () => {
  it("给出来源 / Universe / 额外 / 协议的短语", async () => {
    await i18n.changeLanguage("zh");
    const t = i18n.getFixedT("zh");
    expect(describePreset(EMPTY_PRESET, true, t)).toEqual(["全部来源", "全部 Universe"]);
    expect(
      describePreset(
        preset({
          sources: ["a", "b"],
          universeTokens: ["0-3", "10"],
          extraTokens: ["5"],
          protocols: ["artNet"],
        }),
        true,
        t,
      ),
    ).toEqual(["仅 2 个来源", "Universe 0-3, 10", "额外 5", "仅 Art-Net"]);
  });
});

describe("sanitizePreset", () => {
  it("合法数据原样保留并规整片段", () => {
    const out = sanitizePreset(
      { ...EMPTY_PRESET, universeTokens: ["3-0", "3-0", "x"], nextIndex: 12 },
      EMPTY_PRESET,
    );
    expect(out.universeTokens).toEqual(["0-3"]);
    expect(out.nextIndex).toBe(12);
  });

  it("非法字段回退到当前值；协议为空时恢复全部", () => {
    const current = preset({ nameTemplate: "当前", nextIndex: 3 });
    const out = sanitizePreset(
      { sources: "x", excludeSources: 1, protocols: [], nameTemplate: 5, nextIndex: -2 },
      current,
    );
    expect(out.sources).toEqual([]);
    expect(out.excludeSources).toBe(false);
    expect(out.protocols).toEqual(["artNet", "sacn"]);
    expect(out.nameTemplate).toBe("当前");
    expect(out.nextIndex).toBe(3);
  });

  it("读到 null 时整体回退", () => {
    expect(sanitizePreset(null, EMPTY_PRESET)).toEqual(EMPTY_PRESET);
  });
});
