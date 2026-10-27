import { describe, expect, it } from "vitest";

import {
  activeProgramNo,
  applyAssignments,
  applyDraft,
  draftAssignments,
  isValidProgramNo,
  mergeDraft,
  planReorder,
  planSetNumber,
  smallestFreeProgramNo,
  touchesProgramNo,
} from "../files";
import type { NetFile } from "../types";

const f = (name: string, program: number | null): NetFile => ({ name, size: 1, isDir: false, program });

describe("节目号合法性与空闲号", () => {
  it("只接受 1~255 的整数", () => {
    expect([0, 1, 255, 256, 1.5, Number.NaN, -3].map(isValidProgramNo)).toEqual([false, true, true, false, false, false, false]);
  });

  it("最小空闲号：跳过已占用的，全占满返回 null", () => {
    expect(smallestFreeProgramNo([f("a", 1), f("b", 2), f("c", 4)])).toBe(3);
    expect(smallestFreeProgramNo([])).toBe(1);
    const full = Array.from({ length: 255 }, (_, i) => f(`n${i}`, i + 1));
    expect(smallestFreeProgramNo(full)).toBeNull();
  });
});

describe("planReorder 拖动排序", () => {
  const list = [f("a", 1), f("b", 2), f("c", 5), f("d", 9)];

  it("编号位置不变，文件按新顺序依次占用（间隔保持）", () => {
    // c 拖到最前：#1 c、#2 a、#5 b、#9 d
    expect(planReorder(list, 2, 0)).toEqual([
      { no: 1, file: "c" },
      { no: 2, file: "a" },
      { no: 5, file: "b" },
    ]);
  });

  it("向后拖：只动区间内的文件", () => {
    // a 拖到 c 的位置：#1 b、#2 c、#5 a
    expect(planReorder(list, 0, 2)).toEqual([
      { no: 1, file: "b" },
      { no: 2, file: "c" },
      { no: 5, file: "a" },
    ]);
  });

  it("相邻交换只产生两条", () => {
    expect(planReorder(list, 1, 2)).toEqual([
      { no: 2, file: "c" },
      { no: 5, file: "b" },
    ]);
  });

  it("没有移动或下标无效时不产生分配", () => {
    expect(planReorder(list, 1, 1)).toEqual([]);
    expect(planReorder(list, -1, 2)).toEqual([]);
    expect(planReorder(list, 0, 9)).toEqual([]);
  });

  it("结果是一个排列：节目号与文件都不重复，且只在这批文件之间流转", () => {
    const plan = planReorder(list, 3, 0);
    expect(new Set(plan.map((a) => a.no)).size).toBe(plan.length);
    expect(new Set(plan.map((a) => a.file)).size).toBe(plan.length);
    expect(plan.map((a) => a.no).sort()).toEqual([1, 2, 5, 9]);
  });
});

describe("planSetNumber 修改节目号", () => {
  const files = [f("a", 1), f("b", 2), f("c", null)];

  it("目标号空闲：直接改", () => {
    expect(planSetNumber(files, "a", 7)).toEqual({ kind: "assign", assignments: [{ no: 7, file: "a" }] });
    expect(planSetNumber(files, "c", 3)).toEqual({ kind: "assign", assignments: [{ no: 3, file: "c" }] });
  });

  it("目标号被占用：与对方互换，先让当前文件占号，再把原号给对方", () => {
    expect(planSetNumber(files, "a", 2)).toEqual({
      kind: "swap",
      other: "b",
      assignments: [
        { no: 2, file: "a" },
        { no: 1, file: "b" },
      ],
    });
  });

  it("没有编号的文件不能抢别人的号", () => {
    expect(planSetNumber(files, "c", 1)).toEqual({ kind: "taken", other: "a" });
  });

  it("与现在相同或不合法", () => {
    expect(planSetNumber(files, "a", 1)).toEqual({ kind: "same" });
    expect(planSetNumber(files, "a", 0)).toEqual({ kind: "invalid" });
    expect(planSetNumber(files, "a", Number.NaN)).toEqual({ kind: "invalid" });
    expect(planSetNumber(files, "nope", 3)).toEqual({ kind: "invalid" });
  });
});

describe("applyAssignments 乐观更新", () => {
  it("互换后两个文件的号对调", () => {
    const files = [f("a", 1), f("b", 2)];
    const plan = planSetNumber(files, "a", 2);
    if (plan.kind !== "swap") throw new Error("应是互换");
    expect(applyAssignments(files, plan.assignments).map((x) => [x.name, x.program])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("一个文件只有一个编号：改号会腾出旧号；被覆盖的文件失去编号", () => {
    expect(applyAssignments([f("a", 1), f("b", 2)], [{ no: 7, file: "a" }]).map((x) => x.program)).toEqual([7, 2]);
    expect(applyAssignments([f("a", 1), f("b", 2)], [{ no: 2, file: "a" }]).map((x) => x.program)).toEqual([2, null]);
  });

  it("不修改传入的列表", () => {
    const files = [f("a", 1)];
    applyAssignments(files, [{ no: 3, file: "a" }]);
    expect(files[0].program).toBe(1);
  });
});

describe("正在播放的节目不能被改号", () => {
  const files = [f("a", 1), f("b", 2), f("c", 3)];

  it("activeProgramNo 只在播放 / 暂停时有值", () => {
    expect(activeProgramNo({ state: 2, programNo: 4, posMs: 0, durMs: 0 })).toBe(4);
    expect(activeProgramNo({ state: 3, programNo: 4, posMs: 0, durMs: 0 })).toBe(4);
    expect(activeProgramNo({ state: 1, programNo: 4, posMs: 0, durMs: 0 })).toBeNull();
    expect(activeProgramNo(null)).toBeNull();
  });

  it("目标号或文件当前的号等于播放号都算动到", () => {
    expect(touchesProgramNo(files, [{ no: 2, file: "a" }], 2)).toBe(true); // 目标号
    expect(touchesProgramNo(files, [{ no: 9, file: "b" }], 2)).toBe(true); // 文件当前的号
    expect(touchesProgramNo(files, [{ no: 9, file: "c" }], 2)).toBe(false);
  });
});

describe("暂存更改（一次性提交）", () => {
  const base = [f("a", 1), f("b", 2), f("c", null)];

  it("mergeDraft：只记录与设备不同的项；回到原值就撤销", () => {
    const d1 = mergeDraft(new Map(), base, [{ no: 7, file: "a" }]);
    expect([...d1]).toEqual([["a", 7]]);
    const d2 = mergeDraft(d1, base, [{ no: 1, file: "a" }]);
    expect(d2.size).toBe(0);
  });

  it("mergeDraft：忽略设备上不存在的文件，且不修改入参", () => {
    const d0 = new Map<string, number>();
    const d1 = mergeDraft(d0, base, [{ no: 3, file: "ghost" }]);
    expect(d1.size).toBe(0);
    mergeDraft(d0, base, [{ no: 3, file: "c" }]);
    expect(d0.size).toBe(0);
  });

  it("applyDraft：叠加暂存值，不修改设备列表", () => {
    const view = applyDraft(base, new Map([["a", 2], ["b", 1]]));
    expect(view.map((x) => x.program)).toEqual([2, 1, null]);
    expect(base[0].program).toBe(1);
  });

  it("多次编辑可叠加：互换后再给未编号文件分配空闲号，得到一次性提交的完整分配", () => {
    let draft = mergeDraft(new Map(), base, [
      { no: 2, file: "a" },
      { no: 1, file: "b" },
    ]);
    const view = applyDraft(base, draft);
    const plan = planSetNumber(view, "c", 3);
    expect(plan.kind).toBe("assign");
    if (plan.kind === "assign") draft = mergeDraft(draft, base, plan.assignments);
    expect(draftAssignments(base, draft)).toEqual([
      { no: 2, file: "a" },
      { no: 1, file: "b" },
      { no: 3, file: "c" },
    ]);
  });

  it("draftAssignments：设备上已不存在的文件、与设备一致的项都不进入提交", () => {
    const draft = new Map([["a", 1], ["ghost", 9], ["b", 5]]);
    expect(draftAssignments(base, draft)).toEqual([{ no: 5, file: "b" }]);
    expect(draftAssignments(base, new Map())).toEqual([]);
  });
});
