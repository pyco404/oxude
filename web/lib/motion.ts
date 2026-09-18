"use client";

import { useEffect, useRef, useState } from "react";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Counts from 0 up to `target` over `durationMs`, once, the first time a target
 * arrives. Later changes to the target land instantly: this is arrival motion,
 * not something that replays whenever a number updates. With reduced motion,
 * the final value renders straight away.
 */
export function useCountUp(target: number | undefined, durationMs = 400, delayMs = 0): number | undefined {
  const [value, setValue] = useState<number | undefined>(undefined);
  const played = useRef(false);

  useEffect(() => {
    if (target === undefined) return;
    if (played.current || prefersReducedMotion()) {
      setValue(target);
      return;
    }
    played.current = true;
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now + delayMs;
      const t = Math.min(1, Math.max(0, (now - start) / durationMs));
      // Ease out: fast at first, settling onto the real value.
      setValue(target * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setValue(0);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setValue(target);
    };
  }, [target, durationMs, delayMs]);

  return value;
}
