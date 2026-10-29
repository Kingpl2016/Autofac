import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs } from "@/shared/stores/persistPrefs";
import type { ColorValue } from "../lib/project";
import { colorValueSchema } from "../lib/schema";

/** 我的色板最多保存多少个颜色。 */
export const MAX_USER_SWATCHES = 48;

/** 我的色板里的一个颜色。 */
export interface UserSwatch {
  id: string;
  /** 名称（可留空，显示时用十六进制） */
  name: string;
  color: ColorValue;
}

/** 落盘的数据。 */
interface UserSwatchesData {
  swatches: UserSwatch[];
}

interface UserSwatchesState extends UserSwatchesData {
  /**
   * 加入一个颜色（已有同样的颜色时不重复加入）。
   *
   * @param color 颜色。
   * @param name 名称。
   * @returns 新色块的 `id`；已存在或已满时为已有色块的 `id` / `null`。
   */
  add: (color: ColorValue, name?: string) => string | null;
  /**
   * 改名（首尾空白去掉，最长 40 字）。
   *
   * @param id 色块。
   * @param name 新名称。
   */
  rename: (id: string, name: string) => void;
  /**
   * 删除。
   *
   * @param id 色块。
   */
  remove: (id: string) => void;
  /**
   * 前后移动一格。
   *
   * @param id 色块。
   * @param delta `-1` 前移，`1` 后移。
   */
  move: (id: string, delta: -1 | 1) => void;
}

const swatchSchema = z.object({
  id: z.string().regex(/^[\w-]{1,32}$/),
  name: z.string().max(40),
  color: colorValueSchema,
});

const sameColor = (a: ColorValue, b: ColorValue) => JSON.stringify(a) === JSON.stringify(b);

/** 生成色块 id。 */
const newId = () => `sw-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * 我的色板：用户自己保存的颜色（跨工程），落盘到界面偏好文件（键 `editor-user-swatches`）。
 */
export const useUserSwatchesStore = create<UserSwatchesState>()(
  persist(
    (set, get) => ({
      swatches: [],
      add: (color, name = "") => {
        const existing = get().swatches.find((s) => sameColor(s.color, color));
        if (existing) return existing.id;
        if (get().swatches.length >= MAX_USER_SWATCHES) return null;
        const id = newId();
        set((s) => ({ swatches: [...s.swatches, { id, name: name.trim().slice(0, 40), color: structuredClone(color) }] }));
        return id;
      },
      rename: (id, name) =>
        set((s) => ({ swatches: s.swatches.map((x) => (x.id === id ? { ...x, name: name.trim().slice(0, 40) } : x)) })),
      remove: (id) => set((s) => ({ swatches: s.swatches.filter((x) => x.id !== id) })),
      move: (id, delta) =>
        set((s) => {
          const i = s.swatches.findIndex((x) => x.id === id);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= s.swatches.length) return s;
          const next = [...s.swatches];
          [next[i], next[j]] = [next[j], next[i]];
          return { swatches: next };
        }),
    }),
    persistPrefs<UserSwatchesState, UserSwatchesData>({
      name: "editor-user-swatches",
      version: 1,
      // 逐条校验：坏的条目丢掉，其余保留
      schema: z.object({
        swatches: z
          .array(z.unknown())
          .transform((list) =>
            list
              .map((x) => swatchSchema.safeParse(x))
              .filter((r) => r.success)
              .map((r) => r.data as UserSwatch)
              .slice(0, MAX_USER_SWATCHES),
          )
          .catch([]),
      }),
    }),
  ),
);
