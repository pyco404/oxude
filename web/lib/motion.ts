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

/**
 * A counter that ticks: whenever `target` changes, it runs from the value on
 * screen to the new one over `durationMs`. Unlike useCountUp it plays on every
 * change, because here the change is the news. The first value lands as is,
 * and with reduced motion so does every one after it.
 */
export function useTicker(target: number | undefined, durationMs = 900): number | undefined {
  const [value, setValue] = useState<number | undefined>(target);
  const shown = useRef<number | undefined>(target);

  useEffect(() => {
    const from = shown.current;
    if (target === undefined || from === undefined || from === target || prefersReducedMotion()) {
      shown.current = target;
      setValue(target);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / durationMs);
      const v = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      shown.current = v;
      setValue(v);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}
