import baseTheme from "../../theme.json";
import { BUILT_IN_PALETTES, STANDARD_COLORS, type ThemeColors } from "../../themePaletteData";
import { DEFAULT_CONTRAST } from "./builtTheme";
import type { CustomTheme } from "./customThemes";

type Rgba = [number, number, number, number];
type TokenMap = Record<string, string>;

export interface LiveThemeDocument {
  name: string;
  cssVars: {
    theme: TokenMap;
    light: TokenMap;
    dark: TokenMap;
  };
}

const ROLES: ReadonlyArray<readonly [string, keyof ThemeColors]> = [
  ["background", "canvas"], ["app-chrome-background", "chrome"], ["toolbar-background", "toolbar"],
  ["toolbar-foreground", "toolbarForeground"], ["toolbar-border", "toolbarBorder"], ["toolbar-control", "toolbarControl"],
  ["toolbar-control-foreground", "toolbarControlForeground"], ["toolbar-control-hover", "toolbarControlHover"],
  ["surface-raised", "surfaceRaised"], ["foreground", "text"], ["card", "surface"], ["card-foreground", "text"],
  ["popover", "surfaceOverlay"], ["popover-foreground", "text"], ["primary", "messageAction"],
  ["primary-foreground", "messageActionForeground"], ["secondary", "secondary"], ["secondary-foreground", "secondaryForeground"],
  ["muted", "muted"], ["muted-foreground", "mutedForeground"], ["placeholder", "placeholder"],
  ["secondary-label", "secondaryLabel"], ["icon-muted", "iconMuted"], ["accent", "accentSurface"],
  ["accent-foreground", "accentSurfaceForeground"], ["message-surface", "messageSurface"], ["message-foreground", "messageForeground"],
  ["message-action", "messageAction"], ["message-action-foreground", "messageActionForeground"], ["message-action-hover", "messageActionHover"],
  ["error", "error"], ["error-foreground", "errorForeground"], ["error-surface", "errorSurface"], ["tool-error-icon", "errorForeground"],
  ["destructive", "error"], ["destructive-foreground", "errorForeground"], ["warning", "warning"], ["warning-foreground", "warningForeground"],
  ["warning-surface", "warningSurface"], ["update", "update"], ["update-foreground", "updateForeground"], ["border", "border"],
  ["input", "input"], ["ring", "focus"], ["sidebar", "sidebar"], ["sidebar-foreground", "sidebarForeground"],
  ["sidebar-muted-foreground", "sidebarMutedForeground"], ["sidebar-control-surface", "sidebarControlSurface"],
  ["sidebar-row-hover", "sidebarRowHover"], ["sidebar-row-active", "sidebarRowActive"], ["sidebar-row-selected", "sidebarRowSelected"],
  ["sidebar-border", "sidebarBorder"], ["sidebar-stage-fade", "sidebar"], ["code-background", "codeBackground"],
  ["code-foreground", "codeForeground"], ["terminal-background", "terminalBackground"], ["terminal-foreground", "terminalForeground"],
  ["terminal-cursor", "terminalCursor"], ["terminal-selection-background", "terminalSelection"],
];

const CONTRAST_FOREGROUNDS: ReadonlyArray<readonly [string, string]> = [
  ["toolbar-foreground", "toolbar-background"], ["toolbar-control-foreground", "toolbar-control"],
  ["foreground", "background"], ["muted-foreground", "background"], ["placeholder", "background"],
  ["secondary-label", "background"], ["icon-muted", "background"], ["card-foreground", "card"],
  ["popover-foreground", "popover"], ["accent-foreground", "accent"], ["secondary-foreground", "secondary"],
  ["message-foreground", "message-surface"], ["sidebar-foreground", "sidebar"], ["sidebar-muted-foreground", "sidebar"],
];

const CONTRAST_BORDERS: ReadonlyArray<readonly [string, string]> = [
  ["toolbar-border", "toolbar-foreground"], ["input", "foreground"], ["border", "foreground"], ["sidebar-border", "sidebar-foreground"],
];

const FLATTEN: ReadonlyArray<readonly [string, number, string]> = [
  ["card", 40, "background"], ["border", 60, "card"], ["border", 50, "card"], ["accent", 50, "card"],
  ["border", 100, "card"], ["input", 100, "card"], ["input", 32, "card"],
  ["sidebar-row-selected", 100, "sidebar"], ["sidebar-row-hover", 100, "sidebar"], ["sidebar-row-active", 100, "sidebar"],
  ["muted", 100, "background"], ["muted", 10, "card"],
  ["muted-foreground", 80, "card"], ["muted-foreground", 70, "card"], ["accent", 100, "background"],
  ["popover", 84, "background"], ["border", 70, "popover"], ["muted", 40, "popover"], ["muted", 30, "popover"],
  ["muted", 72, "background"], ["muted", 50, "card"],
  ["warning", 4, "sidebar-grain"], ["warning", 8, "sidebar-grain"],
  ["info", 28, "background"], ["info", 40, "background"], ["info", 32, "background"], ["info", 4, "background"],
  ["destructive", 8, "background"],
];

function encodeChannel(channel: number): number {
  const clamped = Math.max(0, Math.min(1, channel));
  return Math.round(255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055));
}

function decodeChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    encodeChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = decodeChannel(r);
  const lg = decodeChannel(g);
  const lb = decodeChannel(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function parseColor(value: string): Rgba | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex && [3, 4, 6, 8].includes(hex[1]!.length)) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (rgb) {
    const rawAlpha = rgb[4];
    const alpha = rawAlpha ? (rawAlpha.endsWith("%") ? parseFloat(rawAlpha) / 100 : parseFloat(rawAlpha)) : 1;
    return [parseFloat(rgb[1]!), parseFloat(rgb[2]!), parseFloat(rgb[3]!), alpha];
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (oklch) {
    const L = parseFloat(oklch[1]!);
    const C = parseFloat(oklch[2]!);
    const hue = (parseFloat(oklch[3]!) * Math.PI) / 180;
    const rawAlpha = oklch[4];
    const alpha = rawAlpha ? (rawAlpha.endsWith("%") ? parseFloat(rawAlpha) / 100 : parseFloat(rawAlpha)) : 1;
    const [r, g, b] = oklabToRgb(L, C * Math.cos(hue), C * Math.sin(hue));
    return [r, g, b, alpha];
  }
  return null;
}

function fmt([r, g, b, a]: Rgba): string {
  const cr = Math.max(0, Math.min(255, Math.round(r)));
  const cg = Math.max(0, Math.min(255, Math.round(g)));
  const cb = Math.max(0, Math.min(255, Math.round(b)));
  return a >= 0.9995 ? `rgb(${cr},${cg},${cb})` : `rgba(${cr},${cg},${cb},${Number(a.toFixed(4))})`;
}

function mixOklab(first: Rgba, p: number, second: Rgba): Rgba {
  const lab1 = rgbToOklab(first[0], first[1], first[2]);
  const lab2 = rgbToOklab(second[0], second[1], second[2]);
  const w1 = first[3] * p;
  const w2 = second[3] * (1 - p);
  const alpha = w1 + w2;
  if (alpha <= 0) return [0, 0, 0, 0];
  const [r, g, b] = oklabToRgb(
    (lab1[0] * w1 + lab2[0] * w2) / alpha,
    (lab1[1] * w1 + lab2[1] * w2) / alpha,
    (lab1[2] * w1 + lab2[2] * w2) / alpha,
  );
  return [r, g, b, alpha];
}

function mixSrgb(first: Rgba, p: number, second: Rgba): Rgba {
  const wa = first[3] * p;
  const wb = second[3] * (1 - p);
  const alpha = wa + wb;
  if (alpha <= 0) return [0, 0, 0, 0];
  return [
    (first[0] * wa + second[0] * wb) / alpha,
    (first[1] * wa + second[1] * wb) / alpha,
    (first[2] * wa + second[2] * wb) / alpha,
    alpha,
  ];
}

function over(front: readonly number[], back: readonly number[], alpha: number): [number, number, number] {
  return [
    front[0]! * alpha + back[0]! * (1 - alpha),
    front[1]! * alpha + back[1]! * (1 - alpha),
    front[2]! * alpha + back[2]! * (1 - alpha),
  ];
}

function resolveRoles(themeId: string, mode: "light" | "dark", customs: ReadonlyMap<string, CustomTheme>): Partial<ThemeColors> {
  if (themeId === "default") return STANDARD_COLORS[mode];
  const custom = customs.get(themeId);
  if (custom) {
    const t3Chat = BUILT_IN_PALETTES.find((palette) => palette.id === "t3-chat") ?? BUILT_IN_PALETTES[0]!;
    const useVariant = mode !== custom.appearance && custom.variants?.[mode];
    const paletteMode = useVariant ? mode : custom.appearance;
    const overrides = useVariant ? custom.variants![mode]! : custom.colors;
    const base = (paletteMode === t3Chat.appearance ? t3Chat.colors : t3Chat.variants?.[paletteMode]) ?? t3Chat.colors;
    return { ...base, ...overrides };
  }
  const palette = BUILT_IN_PALETTES.find((candidate) => candidate.id === themeId);
  if (!palette) return STANDARD_COLORS[mode];
  if (mode === palette.appearance) return palette.colors;
  return palette.variants?.[mode] ?? palette.colors;
}

function applyContrast(tokens: TokenMap, contrast: number, appearance: "light" | "dark"): TokenMap {
  if (contrast === DEFAULT_CONTRAST) return { ...tokens };
  const base = Math.min(contrast, 100) / 100;
  const boost = Math.max(contrast - 100, 0) / 100;
  const borderBoost = boost / 4;
  const target: Rgba = appearance === "dark" ? [255, 255, 255, 1] : [0, 0, 0, 1];
  const colors = new Map<string, Rgba>();
  for (const [name, value] of Object.entries(tokens)) {
    const parsed = parseColor(value);
    if (parsed) colors.set(name, parsed);
  }
  const out: TokenMap = { ...tokens };
  for (const [name, surface] of CONTRAST_FOREGROUNDS) {
    const fg = colors.get(name);
    const bg = colors.get(surface);
    if (!fg || !bg) continue;
    const inner = mixOklab(fg, base, bg);
    out[name] = fmt(mixOklab(inner, 1 - boost, target));
  }
  for (const [name, line] of CONTRAST_BORDERS) {
    const border = colors.get(name);
    const fg = colors.get(line);
    if (!border || !fg) continue;
    const inner: Rgba = [border[0], border[1], border[2], border[3] * base];
    out[name] = fmt(mixSrgb(inner, 1 - borderBoost, fg));
  }
  return out;
}

function flattenTokens(tokens: TokenMap): TokenMap {
  const out: TokenMap = {};
  const colors = new Map<string, Rgba>();
  for (const [name, value] of Object.entries(tokens)) {
    const parsed = parseColor(value);
    if (parsed) colors.set(name, parsed);
  }
  const sidebar = colors.get("sidebar");
  if (sidebar) {
    colors.set("sidebar-grain", [
      128 * 0.035 + sidebar[0] * 0.965,
      128 * 0.035 + sidebar[1] * 0.965,
      128 * 0.035 + sidebar[2] * 0.965,
      sidebar[3],
    ]);
  }
  for (const [token, alpha, base] of FLATTEN) {
    const front = colors.get(token);
    const back = colors.get(base);
    if (!front || !back || front[3] === 0) continue;
    const [r, g, b] = over(front, back, (front[3] * alpha) / 100);
    out[alpha === 100 ? token : `${token}-${alpha}`] = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }

  const required = ["background", "popover", "foreground", "border", "muted-foreground", "card", "muted", "input"] as const;
  if (!required.every((name) => colors.has(name))) return out;

  const opaque = (name: string, bg: readonly number[]): [number, number, number] => {
    const c = colors.get(name)!;
    return over(c, bg, c[3]);
  };
  const tint = (name: string, bg: readonly number[], opacity: number): [number, number, number] => {
    const c = colors.get(name)!;
    return [
      Math.round(c[0] * opacity + bg[0]! * (1 - opacity)),
      Math.round(c[1] * opacity + bg[1]! * (1 - opacity)),
      Math.round(c[2] * opacity + bg[2]! * (1 - opacity)),
    ];
  };

  const background = opaque("background", [0, 0, 0]);
  const pop = opaque("popover", background);
  const card: [number, number, number] = [
    Math.round(pop[0] * 0.84 + background[0] * 0.16),
    Math.round(pop[1] * 0.84 + background[1] * 0.16),
    Math.round(pop[2] * 0.84 + background[2] * 0.16),
  ];
  const dark = background[0] + background[1] + background[2] < 384;
  const hover = dark ? over([255, 255, 255], card, 0.08) : over([0, 0, 0], card, 0.035);
  out["details-row-hover"] = fmt([hover[0], hover[1], hover[2], 1]);
  out["details-card-border"] = fmt([...tint("foreground", card, 0.1), 1]);
  out["details-divider"] = fmt([...tint("border", card, 0.65), 1]);
  out["details-label"] = fmt([...tint("foreground", card, 0.8), 1]);
  out["details-title"] = fmt([...tint("foreground", card, 0.85), 1]);
  out["details-muted-70"] = fmt([...tint("muted-foreground", card, 0.7), 1]);
  out["details-dot-idle"] = fmt([...tint("muted-foreground", card, 0.45), 1]);

  const surface = opaque("card", background);
  out["provider-row-selected"] = fmt([...tint("foreground", surface, 0.06), 1]);
  out["provider-row-hover"] = fmt([...tint("muted", surface, 0.25), 1]);

  const footer = tint("foreground", background, 0.025);
  out["command-footer"] = fmt([...footer, 1]);
  out["command-footer-border"] = fmt([...tint("foreground", footer, 0.07), 1]);
  out["command-footer-kbd"] = fmt([...tint("foreground", footer, 0.08), 1]);

  const cardColor = colors.get("card")!;
  const row = over(cardColor, background, 0.4 * cardColor[3]);
  out["kbd-key"] = fmt([...tint("foreground", row, 0.07), 1]);

  const popColor = colors.get("popover")!;
  const popup = over(popColor, background, 0.84 * popColor[3]);
  const onPopup = (name: string, alpha: number) => fmt([...tint(name, popup, alpha), 1]);
  out["when-group"] = onPopup("muted", 0.1);
  out["when-group-nested"] = onPopup("background", 0.55);
  out["when-condition"] = onPopup("background", 0.6);
  out["when-not"] = onPopup("muted", 0.2);
  out["when-empty"] = onPopup("muted", 0.15);
  out["when-border"] = onPopup("border", 0.6);
  out["when-border-nested"] = onPopup("border", 0.7);
  out["when-empty-border"] = onPopup("border", 0.8);

  const inputColor = colors.get("input")!;
  const track = over(inputColor, background, inputColor[3] * 0.4);
  out["segmented-track"] = fmt([track[0], track[1], track[2], 1]);
  if (dark) {
    out["segmented-active"] = fmt([...tint("input", track, inputColor[3] * 0.72), 1]);
    out["segmented-hover"] = fmt([...tint("input", track, inputColor[3] * 0.32), 1]);
  } else {
    out["segmented-active"] = fmt([background[0], background[1], background[2], 1]);
    out["segmented-hover"] = fmt([...tint("background", track, 0.55), 1]);
  }
  return out;
}

function buildModeTokens(
  mode: "light" | "dark",
  themeId: string,
  contrast: number,
  customs: ReadonlyMap<string, CustomTheme>,
): TokenMap {
  const tokens: TokenMap = { ...(baseTheme.cssVars[mode] as TokenMap) };
  const roles = resolveRoles(themeId, mode, customs);
  const canvas = parseColor(roles.canvas ?? tokens.background ?? "#000000") ?? [0, 0, 0, 1];
  for (const [token, role] of ROLES) {
    const raw = roles[role];
    if (!raw) continue;
    const parsed = parseColor(raw);
    if (!parsed) continue;
    const [r, g, b, a] = parsed;
    const [fr, fg, fb] = a < 1 ? over([r, g, b], canvas, a) : [r, g, b];
    tokens[token] = fmt([fr, fg, fb, 1]);
  }
  const contrasted = applyContrast(tokens, contrast, mode);
  return { ...contrasted, ...flattenTokens(contrasted) };
}

export function generateLiveTheme(
  desired: { light: string; dark: string; contrast: number },
  customList: readonly CustomTheme[] = [],
): LiveThemeDocument {
  const customs = new Map(customList.map((theme) => [theme.id, theme]));
  return {
    name: baseTheme.name,
    cssVars: {
      theme: { ...(baseTheme.cssVars.theme as TokenMap) },
      light: buildModeTokens("light", desired.light, desired.contrast, customs),
      dark: buildModeTokens("dark", desired.dark, desired.contrast, customs),
    },
  };
}
