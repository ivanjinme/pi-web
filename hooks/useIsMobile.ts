"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Returns true when the viewport is at or below the requested breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const subscribe = useCallback((cb: () => void): (() => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  }, [query]);
  const getSnapshot = useCallback((): boolean => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
