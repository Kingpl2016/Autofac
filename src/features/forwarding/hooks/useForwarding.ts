import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getForwarding, saveForwarding } from "../lib/api";
import { moveWithin } from "../lib/order";
import type { ForwardDestination, ForwardingTable } from "../lib/types";

/** 自动保存的防抖延迟（毫秒）。 */
export const AUTOSAVE_DELAY = 2000;

/** 转发表查询缓存键。 */
export const FORWARDING_QUERY_KEY = ["forwarding"] as const;

/** 自动保存状态：空闲 / 有改动等待防抖 / 保存中 / 已保存 / 失败。 */
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/** 查询转发表。 */
export function useForwardingQuery() {
  return useQuery({
    queryKey: FORWARDING_QUERY_KEY,
    queryFn: getForwarding,
  });
}

interface DraftOptions {
  /** 一次保存成功后回调，参数为刚保存的列表（用于同步查询缓存）。 */
  onSaved?: (list: ForwardDestination[]) => void;
}

/**
 * 转发草稿管理：目的地增删改 / 启停 / 复制 + 防抖自动保存。
 *
 * - 所有修改都基于“最新草稿”计算，状态更新器里没有副作用；
 * - 卸载（切换页面）时如果还有未保存的改动，会立刻保存，不会因为离开页面而丢失；
 * - 保存失败时保留未保存标记，`status` 变为 `error`，可调用 `retry` 重试。
 *
 * @param initial 初始转发表（父组件保证已加载）。
 * @param options 可选项，见 {@link DraftOptions}。
 * @returns 草稿列表、保存状态与各操作。
 */
export function useForwardingDraft(initial: ForwardingTable, options: DraftOptions = {}) {
  const { t } = useTranslation();
  const [destinations, setDestinations] = useState<ForwardDestination[]>(
    initial.destinations ?? [],
  );
  const [status, setStatus] = useState<SaveStatus>("idle");
  const latest = useRef(destinations);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { onSaved } = options;

  const persist = useCallback(async () => {
    const list = latest.current;
    dirty.current = false;
    setStatus("saving");
    try {
      await saveForwarding({ destinations: list });
      // 保存期间又有新改动时保持“待保存”，由下一次防抖保存收尾
      if (!dirty.current) setStatus("saved");
      toast.success(t("forwarding.autoSaved"));
      onSaved?.(list);
    } catch (e: unknown) {
      dirty.current = true;
      setStatus("error");
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [t, onSaved]);

  // 定时器与卸载清理里要调用最新的 persist，通过 ref 间接引用，避免闭包过期
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  const commit = useCallback((next: ForwardDestination[]) => {
    latest.current = next;
    dirty.current = true;
    setDestinations(next);
    setStatus("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persistRef.current();
    }, AUTOSAVE_DELAY);
  }, []);

  const upsert = useCallback(
    (dest: ForwardDestination) => {
      const prev = latest.current;
      const exists = prev.some((d) => d.id === dest.id);
      commit(exists ? prev.map((d) => (d.id === dest.id ? dest : d)) : [...prev, dest]);
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => commit(latest.current.filter((d) => d.id !== id)),
    [commit],
  );

  const toggle = useCallback(
    (id: string) =>
      commit(latest.current.map((d) => (d.id === id ? { ...d, enabled: !d.enabled } : d))),
    [commit],
  );

  const duplicate = useCallback(
    (id: string) => {
      const prev = latest.current;
      const src = prev.find((d) => d.id === id);
      if (!src) return;
      const copy = {
        ...src,
        id: crypto.randomUUID(),
        name: `${src.name}${t("forwarding.copySuffix")}`,
      };
      commit([...prev, copy]);
    },
    [commit, t],
  );

  const replaceAll = useCallback((list: ForwardDestination[]) => commit(list), [commit]);

  /**
   * 上移 / 下移一个目的地。
   *
   * @param id 目的地 id。
   * @param direction `-1` 上移，`1` 下移。
   * @param isVisible 判断条目当前是否可见，隐藏项不参与交换。
   */
  const move = useCallback(
    (id: string, direction: -1 | 1, isVisible?: (d: ForwardDestination) => boolean) => {
      const prev = latest.current;
      const next = moveWithin(prev, id, direction, isVisible);
      if (next !== prev) commit([...next]);
    },
    [commit],
  );

  /** 立即保存未保存的改动（没有改动时什么也不做）。 */
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (dirty.current) await persist();
  }, [persist]);

  /** 保存失败后重试。 */
  const retry = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void persist();
  }, [persist]);

  // 卸载时：取消定时器，并把还没保存的改动立即落盘
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (dirty.current) void persistRef.current();
    },
    [],
  );

  return { destinations, status, upsert, remove, toggle, duplicate, replaceAll, move, flush, retry };
}