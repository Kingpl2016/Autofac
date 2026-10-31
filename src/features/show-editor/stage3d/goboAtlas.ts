import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from "three";

import { goboMask, parseGoboRef } from "@/features/fixtures";

/** 每个图案的边长（像素）。 */
export const GOBO_SIZE = 256;
/** 图集的列数与行数（共 32 格，第 0 格是开光的圆形光阑）。 */
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
const SLOTS = ATLAS_COLS * ATLAS_ROWS;

/**
 * 图案图集：一张单通道（R8）纹理，8 × 4 格、每格 256 像素（2 MiB 显存），光束与光斑着色器按格号取图案。
 *
 * - 第 0 格固定为开光（圆形光阑）；其余格按需分配：内置图案同步生成，资源库里的图片异步解码成灰度后写入。
 * - 格子用满时，本帧没有用到的格子先被替换；仍然不够时多出来的图案按开光画。
 * - 图片加载完成后调用 `onChange`（视图据此重画）。
 */
export class GoboAtlas {
  readonly texture: DataTexture;
  readonly #data: Uint8Array;
  readonly #slots = new Map<string, number>();
  /** 每格当前装的引用（第 0 格为空串） */
  readonly #owner: string[] = Array.from({ length: SLOTS }, () => "");
  readonly #usedThisFrame = new Set<number>();
  readonly #loading = new Set<string>();
  readonly #failed = new Set<string>();
  readonly #urlOf: (hash: string) => string | null;
  readonly #onChange: () => void;
  #disposed = false;

  /**
   * @param urlOf 资源散列 → 图片地址；资源库里没有时返回 `null`。
   * @param onChange 有图片写入图集时调用。
   */
  constructor(urlOf: (hash: string) => string | null, onChange: () => void) {
    this.#urlOf = urlOf;
    this.#onChange = onChange;
    this.#data = new Uint8Array(ATLAS_COLS * GOBO_SIZE * ATLAS_ROWS * GOBO_SIZE);
    this.texture = new DataTexture(this.#data, ATLAS_COLS * GOBO_SIZE, ATLAS_ROWS * GOBO_SIZE, RedFormat, UnsignedByteType);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.#write(0, openMask());
  }

  /** 开始新的一帧（重新统计哪些格子在用）。 */
  beginFrame(): void {
    this.#usedThisFrame.clear();
    this.#usedThisFrame.add(0);
  }

  /**
   * 图案所在的格号；第一次用到时分配并写入。
   *
   * @param ref 图案引用；`null` 为开光。
   * @returns 格号（0 为开光）。
   */
  slotOf(ref: string | null): number {
    if (!ref || this.#disposed) return 0;
    const hit = this.#slots.get(ref);
    if (hit !== undefined) {
      this.#usedThisFrame.add(hit);
      return hit;
    }
    const parsed = parseGoboRef(ref);
    if (!parsed || this.#failed.has(ref)) return 0;
    if ("hash" in parsed) {
      // 图片还在解码：先按开光画
      if (!this.#loading.has(ref)) void this.#loadImage(ref, parsed.hash);
      return 0;
    }
    const slot = this.#allocate(ref);
    if (slot === 0) return 0;
    this.#write(slot, goboMask(parsed.builtin, GOBO_SIZE));
    return slot;
  }

  /** 释放纹理。 */
  dispose(): void {
    this.#disposed = true;
    this.texture.dispose();
  }

  /** 分配一个格子（优先空格，其次本帧没用到的）。 */
  #allocate(ref: string): number {
    let slot = this.#owner.findIndex((o, i) => i > 0 && o === "");
    if (slot < 0) slot = this.#owner.findIndex((_, i) => i > 0 && !this.#usedThisFrame.has(i));
    if (slot < 0) return 0;
    const old = this.#owner[slot];
    if (old) this.#slots.delete(old);
    this.#owner[slot] = ref;
    this.#slots.set(ref, slot);
    this.#usedThisFrame.add(slot);
    return slot;
  }

  /** 把一格的灰度写进图集（遮罩第一行是图案上方，纹理第一行在底部，所以倒着写）。 */
  #write(slot: number, mask: Uint8Array): void {
    const width = ATLAS_COLS * GOBO_SIZE;
    const x0 = (slot % ATLAS_COLS) * GOBO_SIZE;
    const y0 = Math.floor(slot / ATLAS_COLS) * GOBO_SIZE;
    for (let y = 0; y < GOBO_SIZE; y++) {
      const row = mask.subarray((GOBO_SIZE - 1 - y) * GOBO_SIZE, (GOBO_SIZE - y) * GOBO_SIZE);
      this.#data.set(row, (y0 + y) * width + x0);
    }
    this.texture.needsUpdate = true;
  }

  async #loadImage(ref: string, hash: string): Promise<void> {
    const url = this.#urlOf(hash);
    if (!url) {
      this.#failed.add(ref);
      return;
    }
    this.#loading.add(ref);
    try {
      const mask = await imageMask(url);
      if (this.#disposed) return;
      const slot = this.#allocate(ref);
      if (slot > 0) {
        this.#write(slot, mask);
        this.#onChange();
      }
    } catch {
      this.#failed.add(ref);
    } finally {
      this.#loading.delete(ref);
    }
  }
}

/** 开光：圆形光阑（边缘一个像素抗锯齿）。 */
function openMask(): Uint8Array {
  const n = GOBO_SIZE;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      out[y * n + x] = Math.round(Math.min(1, Math.max(0, (0.97 - r) * n * 0.5 + 0.5)) * 255);
    }
  }
  return out;
}

/**
 * 读一张图片，缩放到图案尺寸并转成灰度（亮度 × 不透明度：透明处遮光）。
 *
 * @param url 图片地址。
 * @returns 灰度遮罩（第一行在上）。
 * @throws 图片无法解码时。
 */
async function imageMask(url: string): Promise<Uint8Array> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GOBO_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no canvas");
  // 按短边铺满（居中裁切），与实际图案片一样是圆形的
  const s = Math.max(GOBO_SIZE / img.naturalWidth, GOBO_SIZE / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.drawImage(img, (GOBO_SIZE - w) / 2, (GOBO_SIZE - h) / 2, w, h);
  const px = ctx.getImageData(0, 0, GOBO_SIZE, GOBO_SIZE).data;
  const out = new Uint8Array(GOBO_SIZE * GOBO_SIZE);
  for (let i = 0; i < out.length; i++) {
    const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    out[i] = Math.round((l * px[i * 4 + 3]) / 255);
  }
  return out;
}
