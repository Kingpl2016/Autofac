import { describe, expect, it } from "vitest";

import { createAppearanceRegistry } from "@/shared/appearance/registry";
import { isSafeTokenValue, sanitizeTokenMap } from "@/shared/appearance/tokens";
import { getDefaultSettings, sanitizeSettings } from "../appearanceSettings";
import { computeVars, deriveAccentVars } from "../computeVars";
import { mapLegacyPrefs } from "../legacyMigration";
import { BUILTIN_ACCENTS, BUILTIN_FONTS, BUILTIN_THEMES, registerBuiltinPresets } from "../presets/builtinPresets";

describe("token 白名单", () => {
  it("接受合法颜色 / 数字 / 长度 / 字体，拒绝注入和越界", () => {
    expect(isSafeTokenValue("--background", "oklch(0.2 0.01 260)")).toBe(true);
    expect(isSafeTokenValue("--background", "#fff")).toBe(true);
    expect(isSafeTokenValue("--background", "red; background: url(x)")).toBe(false);
    expect(isSafeTokenValue("--background", "url(https://evil.example/x.png)")).toBe(false);
    expect(isSafeTokenValue("--accent-h", "255")).toBe(true);
    expect(isSafeTokenValue("--accent-h", "400")).toBe(false);
    expect(isSafeTokenValue("--accent-c", "0.2")).toBe(true);
    expect(isSafeTokenValue("--accent-c", "0.9")).toBe(false);
    expect(isSafeTokenValue("--radius", "0.5rem")).toBe(true);
    expect(isSafeTokenValue("--radius", "40rem")).toBe(false);
    expect(isSafeTokenValue("--ui-scale", "105")).toBe(true);
    expect(isSafeTokenValue("--ui-scale", "300")).toBe(false);
    expect(isSafeTokenValue("--font-sans", "'Segoe UI', sans-serif")).toBe(true);
    expect(isSafeTokenValue("--font-sans", "x; } body { display:none")).toBe(false);
  });

  it("状态语义色不在白名单内：任何主题都改不了录制红 / 在线绿", () => {
    for (const name of ["--success", "--warning", "--recording", "--online", "--offline", "--destructive"]) {
      expect(isSafeTokenValue(name, "oklch(0.5 0.1 100)"), name).toBe(false);
    }
    expect(sanitizeTokenMap({ "--recording": "#f00", "--card": "#111" })).toEqual({ "--card": "#111" });
  });
});

describe("sanitizeSettings", () => {
  it("非法输入回到默认值，且每个字段独立兜底", () => {
    expect(sanitizeSettings(null)).toEqual(getDefaultSettings());
    expect(sanitizeSettings("oops")).toEqual(getDefaultSettings());

    const result = sanitizeSettings({ mode: "system", radius: 99, density: "huge", scale: 105 });
    expect(result.mode).toBe("system");
    expect(result.radius).toBeNull();
    expect(result.density).toBe("default");
    expect(result.scale).toBe(105);
  });

  it("主题 token 经过白名单过滤，主色必须是 6 位十六进制", () => {
    const result = sanitizeSettings({
      theme: { id: "x", tokens: { light: { "--card": "#fff", "--recording": "#f00" }, dark: null } },
      accent: { id: "custom", color: "not-a-color" },
    });
    expect(result.theme?.tokens.light).toEqual({ "--card": "#fff" });
    expect(result.theme?.tokens.dark).toEqual({});
    expect(result.accent).toBeNull();
  });
});

describe("computeVars", () => {
  it("全部默认时不写任何变量", () => {
    expect(computeVars(getDefaultSettings())).toEqual({ light: {}, dark: {} });
  });

  it("主色折算为强调色色相与彩度，而不是直接覆盖 --primary", () => {
    const vars = computeVars({ ...getDefaultSettings(), accent: { id: "rose", color: "#e11d48" } });
    expect(Object.keys(vars.dark).sort()).toEqual(["--accent-c", "--accent-h"]);
    expect(Number(vars.dark["--accent-h"])).toBeGreaterThan(0);
    expect(vars.dark).toEqual(vars.light);
  });

  it("灰色主色的彩度很低，彩度有上限", () => {
    expect(Number(deriveAccentVars("#52525b")["--accent-c"])).toBeLessThan(0.03);
    expect(Number(deriveAccentVars("#ff00ff")["--accent-c"])).toBeLessThanOrEqual(0.26);
    expect(deriveAccentVars("nope")).toEqual({});
  });

  it("圆角 / 字体 / 缩放 / 密度写入对应变量；100% 缩放与默认密度不写", () => {
    const vars = computeVars({
      ...getDefaultSettings(),
      radius: 0.75,
      scale: 105,
      density: "compact",
      font: { id: "mono", sans: "Consolas, monospace", mono: "Consolas, monospace" },
    });
    expect(vars.light).toMatchObject({
      "--radius": "0.75rem",
      "--ui-scale": "105",
      "--density-gutter": "1rem",
      "--density-gap": "0.875rem",
      "--font-sans": "Consolas, monospace",
      "--font-mono": "Consolas, monospace",
    });
    const plain = computeVars({ ...getDefaultSettings(), scale: 100, density: "default" });
    expect(plain.light).toEqual({});
  });

  it("主题的表面色先写入，主色与形状设置叠加在其上", () => {
    const theme = BUILTIN_THEMES.find((t) => t.id === "ocean")!;
    const vars = computeVars({
      ...getDefaultSettings(),
      theme: { id: theme.id, tokens: theme.tokens },
      accent: { id: "rose", color: "#e11d48" },
      radius: 1,
    });
    expect(vars.dark["--background"]).toBeDefined();
    expect(vars.dark["--surface-2"]).toBeDefined();
    expect(vars.dark["--accent-h"]).toBeDefined();
    expect(vars.dark["--radius"]).toBe("1rem");
    // 主题不覆盖主色与状态语义色
    expect(vars.dark["--primary"]).toBeUndefined();
    expect(vars.dark["--recording"]).toBeUndefined();
  });
});

describe("内置预设", () => {
  it("所有内置主题的 token 都能通过白名单（没有被过滤掉）", () => {
    for (const preset of BUILTIN_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        expect(sanitizeTokenMap(preset.tokens[mode]), `${preset.id}/${mode}`).toEqual(preset.tokens[mode]);
      }
    }
  });

  it("id 唯一，旧版强调色 id 都有对应的内置主色，字体栈都通过校验", () => {
    for (const list of [BUILTIN_THEMES, BUILTIN_ACCENTS, BUILTIN_FONTS]) {
      const ids = list.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const legacy of ["blue", "cyan", "green", "orange", "violet", "rose"]) {
      expect(BUILTIN_ACCENTS.map((p) => p.id)).toContain(legacy);
    }
    for (const font of BUILTIN_FONTS) {
      expect(isSafeTokenValue("--font-sans", font.sans), font.id).toBe(true);
      if (font.mono) expect(isSafeTokenValue("--font-mono", font.mono), font.id).toBe(true);
    }
  });

  it("注册后可读取，取消注册后消失；非法主色被忽略", () => {
    const registry = createAppearanceRegistry();
    const off = registerBuiltinPresets(registry);
    expect(registry.themes.list()).toHaveLength(BUILTIN_THEMES.length);
    expect(registry.accents.list()).toHaveLength(BUILTIN_ACCENTS.length);

    const bad = registry.registerAccent({ id: "bad", label: "Bad", color: "red" });
    expect(registry.accents.list().some((a) => a.id === "bad")).toBe(false);
    bad();

    off();
    expect(registry.themes.list()).toHaveLength(0);
    expect(registry.fonts.list()).toHaveLength(0);
  });

  it("插件注册的主题 token 会被过滤", () => {
    const registry = createAppearanceRegistry();
    registry.registerTheme({
      id: "evil",
      label: "Evil",
      tokens: { light: { "--card": "#fff", "--recording": "#f00" }, dark: {} },
    });
    expect(registry.themes.list()[0].tokens.light).toEqual({ "--card": "#fff" });
  });
});

describe("旧版偏好迁移", () => {
  it("深浅模式直接迁移；旧默认蓝色保持“未选择”，其它强调色映射到同名内置主色", () => {
    expect(mapLegacyPrefs({ theme: "light", accent: "blue" })).toEqual({ mode: "light" });
    expect(mapLegacyPrefs({ theme: "dark", accent: "rose" })).toEqual({
      mode: "dark",
      accent: { id: "rose", color: "#e11d48" },
    });
  });

  it("没有可迁移内容或数据非法时返回 null", () => {
    expect(mapLegacyPrefs(null)).toBeNull();
    expect(mapLegacyPrefs({ theme: "neon", accent: "plaid" })).toBeNull();
    expect(mapLegacyPrefs({ accent: "blue" })).toBeNull();
  });
});
