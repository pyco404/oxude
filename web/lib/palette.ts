/**
 * The palette for the few places CSS variables cannot reach: the share images
 * (rendered to PNG, where there is no stylesheet), the browser's theme-color,
 * and Privy's login modal. app/globals.css is the source; these must match it.
 */
export const palette = {
  ink: "#141a24",
  panel: "#1f1d1a",
  text: "#ede6d6",
  muted: "#a79f90",
  accent: "#e8b84b",
  live: "#6f9e5c",
  loss: "#d4745a",
  brand: "#ff2d2d",
} as const;
