import { describe, expect, it } from "vitest";

import { canMove, moveWithin } from "../order";

const ids = (l: readonly { id: string }[]) => l.map((x) => x.id).join("");
const mk = (s: string) => [...s].map((id) => ({ id }));

describe("moveWithin", () => {
  it("上移 / 下移与相邻项交换", () => {
    expect(ids(moveWithin(mk("abc"), "b", -1))).toBe("bac");
    expect(ids(moveWithin(mk("abc"), "b", 1))).toBe("acb");
  });

  it("在两端无法继续移动时返回同一个数组", () => {
    const list = mk("abc");
    expect(moveWithin(list, "a", -1)).toBe(list);
    expect(moveWithin(list, "c", 1)).toBe(list);
  });

  it("条目不存在时返回同一个数组", () => {
    const list = mk("abc");
    expect(moveWithin(list, "x", 1)).toBe(list);
  });

  it("跳过被隐藏的邻居，只与可见邻居交换", () => {
    // b、d 被隐藏：可见的是 a c e
    const visible = (x: { id: string }) => !"bd".includes(x.id);
    expect(ids(moveWithin(mk("abcde"), "c", -1, visible))).toBe("cbade");
    expect(ids(moveWithin(mk("abcde"), "c", 1, visible))).toBe("abedc");
  });

  it("可见区域的边界处不会越过隐藏项继续移动", () => {
    const visible = (x: { id: string }) => x.id !== "a";
    const list = mk("abc");
    // b 已经是第一个可见项
    expect(moveWithin(list, "b", -1, visible)).toBe(list);
  });

  it("不修改入参", () => {
    const list = mk("abc");
    moveWithin(list, "b", 1);
    expect(ids(list)).toBe("abc");
  });
});

describe("canMove", () => {
  it("两端不可移动，中间两个方向都可以", () => {
    const list = mk("abc");
    expect(canMove(list, "a", -1)).toBe(false);
    expect(canMove(list, "a", 1)).toBe(true);
    expect(canMove(list, "b", -1)).toBe(true);
    expect(canMove(list, "c", 1)).toBe(false);
  });
});