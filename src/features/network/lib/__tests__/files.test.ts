import { describe, expect, it } from "vitest";

import { baseName, filePlayState, findOverwrites, isPlayableMode, sortFiles } from "../files";
import type { NetFile } from "../types";
import { validateProgramFileName } from "../validate";

const f = (name: string, program: number | null, isDir = false): NetFile => ({ name, size: 1, isDir, program });

describe("files", () => {
  it("baseName 兼容两种分隔符", () => {
    expect(baseName("C:\\a\\b\\x.artrec")).toBe("x.artrec");
    expect(baseName("/tmp/x.artrec")).toBe("x.artrec");
    expect(baseName("x.artrec")).toBe("x.artrec");
  });

  it("sortFiles：按节目号升序，未分配在后，过滤目录", () => {
    const sorted = sortFiles([f("z.artrec", null), f("b.artrec", 3), f("DIR", null, true), f("a.artrec", 1), f("c.artrec", null)]);
    expect(sorted.map((x) => x.name)).toEqual(["a.artrec", "b.artrec", "c.artrec", "z.artrec"]);
  });

  it("只有模式 0 与 4 允许播放", () => {
    expect([0, 1, 2, 3, 4, 5].filter(isPlayableMode)).toEqual([0, 4]);
  });

  it("filePlayState 按节目号与状态判断", () => {
    const file = f("a.artrec", 2);
    expect(filePlayState(file, { state: 2, programNo: 2, posMs: 0, durMs: 0 })).toBe("playing");
    expect(filePlayState(file, { state: 3, programNo: 2, posMs: 0, durMs: 0 })).toBe("paused");
    expect(filePlayState(file, { state: 1, programNo: 2, posMs: 0, durMs: 0 })).toBeNull();
    expect(filePlayState(file, { state: 2, programNo: 3, posMs: 0, durMs: 0 })).toBeNull();
    expect(filePlayState(f("n.artrec", null), { state: 2, programNo: 0, posMs: 0, durMs: 0 })).toBeNull();
    expect(filePlayState(file, null)).toBeNull();
  });

  it("findOverwrites 不区分大小写并返回设备上的原名", () => {
    expect(findOverwrites(["SHOW.artrec", "new.artrec"], [f("show.ARTREC", 1)])).toEqual(["show.ARTREC"]);
  });
});

describe("validateProgramFileName", () => {
  it("接受合法名称（含中文与大写扩展名）", () => {
    expect(validateProgramFileName("开场秀.artrec")).toBeNull();
    expect(validateProgramFileName("A.ARTREC")).toBeNull();
  });

  it("拒绝空名、超长、非法字符与错误扩展名", () => {
    expect(validateProgramFileName("")).toBe("network.files.nameEmpty");
    expect(validateProgramFileName(`${"x".repeat(125)}.artrec`)).toBe("network.files.nameTooLong");
    // 41 个汉字 = 123 字节，加上 .artrec 共 130 字节：超长按字节而不是字符数计
    expect(validateProgramFileName(`${"汉".repeat(41)}.artrec`)).toBe("network.files.nameTooLong");
    expect(validateProgramFileName(`${"汉".repeat(40)}.artrec`)).toBeNull();
    expect(validateProgramFileName("a/b.artrec")).toBe("network.files.nameChars");
    expect(validateProgramFileName("a..b.artrec")).toBe("network.files.nameChars");
    expect(validateProgramFileName("a\n.artrec")).toBe("network.files.nameChars");
    expect(validateProgramFileName("a.txt")).toBe("network.files.nameExt");
    expect(validateProgramFileName(".artrec")).toBe("network.files.nameExt");
  });
});
