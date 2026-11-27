// A theme token at a given alpha, as an rgba() string. NSH squares Tailwind alpha modifiers, so
// classes like `bg-foreground/12` or `bg-destructive/90` are built here from the resolved token.
import { colorScheme, platform, token } from "nsh";
import { settingValue } from "../../store";
import { builtThemeForMode } from "../../pages/settings/builtTheme";

/**
 * The red, green and blue of a colour string. `token()` gives a colour as `#rrggbbaa` in the running
 * app (and `rgb(...)` as theme.json writes it elsewhere), so both spellings are read; reading only
 * `rgb(...)` made every mixed surface come out black in the real window.
 */
export function parseColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) return [0, 1, 2].map((index) => parseInt(digits[index]! + digits[index]!, 16)) as [number, number, number];
    if (digits.length === 6 || digits.length === 8) return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16)) as [number, number, number];
    return null;
  }
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function tokenAlpha(name: Parameters<typeof token>[0], alpha: number): string {
  const rgb = parseColor(String(token(name)));
  if (!rgb) return String(token(name));
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function rgbOf(name: Parameters<typeof token>[0]): [number, number, number] {
  return parseColor(String(token(name))) ?? [0, 0, 0];
}

/** `amount` of token `top` over token `base`, flattened to an opaque rgb() (what Tailwind's color-mix builds). */
export function tokenOver(top: Parameters<typeof token>[0], base: Parameters<typeof token>[0], amount: number): string {
  const a = rgbOf(top);
  const b = rgbOf(base);
  const mix = (index: number) => Math.round(a[index]! * amount + b[index]! * (1 - amount));
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

/** The saved Glass opacity as a fraction: the contract's range is 40..100, default 80 (--glass-opacity). */
export function glassOpacity(): number {
  const saved = settingValue("glassOpacity");
  const percent = typeof saved === "number" && Number.isFinite(saved) ? saved : 80;
  return Math.min(100, Math.max(40, percent)) / 100;
}

/** dropdown-glass is the popover at 18% over the popover at --glass-opacity: 0.18 + 0.82 * opacity (0.836 at 80%). */
export const dropdownGlassAmount = (opacity: number = glassOpacity()) => 0.18 + 0.82 * opacity;

/** The web's `dropdown-glass` surface, translucent over the content behind it. */
export const glassPopover = () => tokenAlpha("popover", dropdownGlassAmount());
/** The dropdown-glass outline: contrast-foreground at 10%. */
export const glassOutline = () => tokenAlpha("foreground", 0.1);

/** A translucent overlay on its parent glass surface (the web's `bg-muted/40`). */
export function overGlass(top: Parameters<typeof token>[0], amount: number): string {
  return tokenAlpha(top, amount);
}

/** The composer's glass surface at the configured opacity. */
export function composerGlassSurface(): string {
  const mode = colorScheme() === "dark" ? "dark" : "light";
  const alpha = platform.os === "windows" ? Math.max(glassOpacity(), 0.94) : glassOpacity();
  return tokenAlpha(mode === "dark" || builtThemeForMode(mode) !== "default" ? "surface-raised" : "card", alpha);
}
/** ComposerSurface's default and themed outlines. */
export function composerOutline(): string {
  const mode = colorScheme() === "dark" ? "dark" : "light";
  const theme = builtThemeForMode(mode);
  if (theme === "default") return mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.08)";
  if (mode === "light") return String(token("toolbar-border"));
  return theme === "t3-chat" ? "#241e28" : tokenOver("input", "background", 0.3);
}

/** The inset highlight on a dark composer. */
export function composerHighlight(): string {
  const theme = builtThemeForMode("dark");
  if (theme === "default") return "rgba(255,255,255,0.03)";
  if (theme === "t3-chat") return "rgba(67,45,72,0.12)";
  return tokenAlpha("input", 0.12);
}

/** A token as a tint, or undefined while the theme has none (headless fixtures), so the icon keeps its own colour. */
export function tokenTint(name: Parameters<typeof token>[0]): string | undefined {
  const value = token(name);
  return typeof value === "string" && value.length > 0 && value !== "undefined" ? value : undefined;
}
