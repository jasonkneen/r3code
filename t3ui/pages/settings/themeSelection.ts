// Which theme and colour scheme the user picked: the state behind the Appearance
// panel, the palette's theme rows and the preview tiles. Light and dark each carry
// their own theme id (a built-in card or a custom theme from customThemes.ts).
import { host, setColorScheme } from "nsh";
import { settingValue, updateSetting } from "../../store";
import { THEME_CARDS, type ThemeAppearance, type ThemeCard, type ThemePreviewColors } from "../../themePreviews";
import { BUILT_THEME_ID, builtThemeForMode, themeRebuildAvailable } from "./builtTheme";
import { customThemeById, customThemeCard } from "./customThemes";
import { environmentThemeById, startDefaultThemeAdoption } from "./environmentThemes";
import { serverEnvironment, serverSettings } from "./settingsState";
import { applyingTheme, installThemeSync } from "./themeRequest";

export type Mode = "system" | ThemeAppearance;
const THEME_FIELD: Record<ThemeAppearance, string> = { light: "themeLight", dark: "themeDark" };

/** The scheme the user chose, defaulting to following the system. */
export function appearanceMode(): Mode {
  const value = settingValue("colorScheme");
  return value === "light" || value === "dark" ? value : "system";
}

export function chooseAppearanceMode(mode: Mode) {
  setColorScheme(mode);
  updateSetting("colorScheme", mode);
}

/**
 * The card id the app is showing for one mode: the theme the bundle was built with (builtTheme.ts). A pick
 * is saved at once but only becomes the shown theme after the launcher has rebuilt the window with it
 * (themeRequest.ts), so this never names a theme the window is not painted in.
 */
export function themeForMode(mode: ThemeAppearance): string {
  return builtThemeForMode(mode);
}

/** The card id the user last picked for one mode, the built theme when none. */
export function pickedThemeForMode(mode: ThemeAppearance): string {
  const value = settingValue(THEME_FIELD[mode]);
  if (typeof value !== "string") return builtThemeForMode(mode);
  return THEME_CARDS.some((card) => card.id === value) || customThemeById(value) || environmentThemeById(value) ? value : builtThemeForMode(mode);
}

/** "Applying theme..." while a pick or contrast change is being built into a new window, else empty. */
export const themeNotice = () => (applyingTheme() ? "Applying theme..." : "");

/** Picking a theme saves it for the mode; the settings watcher (themeRequest.ts) asks the launcher to build it. */
export function chooseTheme(mode: ThemeAppearance, id: string) {
  updateSetting(THEME_FIELD[mode], id);
}

/** Puts a theme on every appearance it has (a custom theme has one). */
export function useTheme(card: ThemeCard) {
  for (const preview of card.previews) updateSetting(THEME_FIELD[preview.mode], card.id);
}

/** Makes `id` the theme of each appearance in `modes`: a theme with both is used in both (setTheme), one with a single palette only for its own half (assignHalf). */
export function applyHalves(id: string, modes: ReadonlyArray<ThemeAppearance>) {
  for (const mode of modes) updateSetting(THEME_FIELD[mode], id);
}

/** The theme ids picked for light and dark (the built ones when none was picked). */
export function activeThemeIds(): string[] {
  return [pickedThemeForMode("light"), pickedThemeForMode("dark")];
}

/** A removed theme leaves any appearance that used it on the default theme. */
export function releaseTheme(id: string) {
  for (const mode of ["light", "dark"] as const) if (settingValue(THEME_FIELD[mode]) === id) updateSetting(THEME_FIELD[mode], BUILT_THEME_ID);
}

export function cardById(id: string): ThemeCard {
  const custom = customThemeById(id) ?? environmentThemeById(id);
  if (custom) return customThemeCard(custom);
  return THEME_CARDS.find((card) => card.id === id) ?? THEME_CARDS.find((card) => card.id === BUILT_THEME_ID) ?? THEME_CARDS[0]!;
}

export function previewFor(card: ThemeCard, mode: ThemeAppearance): ThemePreviewColors {
  return (card.previews.find((p) => p.mode === mode) ?? card.previews[0]!).colors;
}

// Started by the launcher with a theme-aware build, or on a host providing live theme.setOverrides (e.g. Windows).
let hostLiveThemes = false;
try { hostLiveThemes = host.available(); } catch { hostLiveThemes = false; }
if (themeRebuildAvailable() || hostLiveThemes) installThemeSync();

// useDefaultTheme.ts startDefaultThemeAdoption: the connected environment's default theme (`defaultTheme`,
// `defaultThemeSetAt`) is applied once per generation; a theme that resolves late (published after the setting) still applies.
startDefaultThemeAdoption({
  environmentId: () => { const id = (serverEnvironment() as Record<string, unknown> | null)?.environmentId; return typeof id === "string" && id ? id : null; },
  settings: () => serverSettings() as Record<string, unknown> | null,
  modesOf: (id) => {
    const theme = customThemeById(id) ?? environmentThemeById(id);
    const card = theme ? customThemeCard(theme) : THEME_CARDS.find((candidate) => candidate.id === id);
    return card ? card.previews.map((preview) => preview.mode) : null;
  },
  apply: (id, modes) => applyHalves(id, modes),
  setAppearance: (mode) => chooseAppearanceMode(mode),
});
