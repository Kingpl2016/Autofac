import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getForwarding, saveForwarding } from "../lib/api";
import type { ForwardDestination, ForwardingTable } from "../lib/types";

const AUTOSAVE_DELAY = 2000;

/** 查询转发表。 */
export function useForwardingQuery() {
  return useQuery({
    queryKey: ["forwarding"],
    queryFn: getForwarding,
  });
}

/**
 * 转发草稿管理：目的地增删改/启停/复制 + 2 秒防抖自动保存。
 *
 * @param initial 初始转发表（父组件保证已加载）。
 */
export function useForwardingDraft(initial: ForwardingTable) {
  const { t } = useTranslation();
  const [destinations, setDestinations] = useState<ForwardDestination[]>(
    initial.destinations ?? [],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (list: ForwardDestination[]) => {
      void saveForwarding({ destinations: list })
        .then(() => toast.success(t("forwarding.autoSaved")))
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : String(e)),
        );
    },
    [t],
  );

  const commit = useCallback(
    (list: ForwardDestination[]) => {
      setDestinations(list);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => persist(list), AUTOSAVE_DELAY);
    },
    [persist],
  );

  const upsert = useCallback(
    (dest: ForwardDestination) =>
      setDestinations((prev) => {
        const idx = prev.findIndex((d) => d.id === dest.id);
        const next =
          idx >= 0
            ? prev.map((d) => (d.id === dest.id ? dest : d))
            : [...prev, dest];
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY);
        return next;
      }),
    [persist],
  );

  const remove = useCallback(
    (id: string) =>
      setDestinations((prev) => {
        const next = prev.filter((d) => d.id !== id);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY);
        return next;
      }),
    [persist],
  );

  const toggle = useCallback(
    (id: string) =>
      setDestinations((prev) => {
        const next = prev.map((d) =>
          d.id === id ? { ...d, enabled: !d.enabled } : d,
        );
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY);
        return next;
      }),
    [persist],
  );

  const duplicate = useCallback(
    (id: string) =>
      setDestinations((prev) => {
        const src = prev.find((d) => d.id === id);
        if (!src) return prev;
        const copy = { ...src, id: crypto.randomUUID(), name: `${src.name} 副本` };
        const next = [...prev, copy];
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY);
        return next;
      }),
    [persist],
  );

  const replaceAll = useCallback(
    (list: ForwardDestination[]) => commit(list),
    [commit],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { destinations, upsert, remove, toggle, duplicate, replaceAll };
}
