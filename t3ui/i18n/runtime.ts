import { effect, host, platform } from "nsh";
import { settingValue } from "../store";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocaleSelection } from "./locales";
import { getActiveLocale, getFormattingLocale, registerLocaleCatalog, setActiveLocale } from "./messages";

const loadedLocales = new Set<string>([DEFAULT_LOCALE]);
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

let requestedCatalogLocale = DEFAULT_LOCALE;
let requestedFormattingLocale = DEFAULT_LOCALE;
let started = false;

async function importLocaleJson(locale: string): Promise<Readonly<Record<string, string>> | null> {
  if (platform.os === "windows" && host.available()) {
    try {
      const external = await host.call("r3.readLocale", { locale }, { timeout: 5000 });
      if (external && typeof external === "object" && !Array.isArray(external)) {
        return external as Readonly<Record<string, string>>;
      }
    } catch {
      /* fall through to bundled import */
    }
  }
  try {
    switch (locale) {
      case "de": return (await import("./translations/de.json")).default;
      case "es": return (await import("./translations/es.json")).default;
      case "fr": return (await import("./translations/fr.json")).default;
      case "ja": return (await import("./translations/ja.json")).default;
      case "ko": return (await import("./translations/ko.json")).default;
      case "pt-BR": return (await import("./translations/pt-BR.json")).default;
      case "ru": return (await import("./translations/ru.json")).default;
      case "sv": return (await import("./translations/sv.json")).default;
      case "zh": return (await import("./translations/zh.json")).default;
      default: return null;
    }
  } catch {
    return null;
  }
}

export function loadLocale(locale: string): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve();
  let load = pendingLoads.get(locale);
  if (!load) {
    load = importLocaleJson(locale).then((catalog) => {
      pendingLoads.delete(locale);
      if (catalog && Object.keys(catalog).length > 0) {
        registerLocaleCatalog(locale, catalog);
        loadedLocales.add(locale);
      }
    });
    pendingLoads.set(locale, load);
  }
  return load;
}

function systemLocales(): ReadonlyArray<string> {
  const nav = (globalThis as { navigator?: { languages?: ReadonlyArray<string>; language?: string } }).navigator;
  if (nav?.languages && nav.languages.length > 0) return nav.languages;
  if (typeof nav?.language === "string" && nav.language.length > 0) return [nav.language];
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    return resolved ? [resolved] : [DEFAULT_LOCALE];
  } catch {
    return [DEFAULT_LOCALE];
  }
}

function activateLocale(catalogLocale: string, formattingLocale: string): void {
  if (requestedCatalogLocale !== catalogLocale || requestedFormattingLocale !== formattingLocale) return;
  if (getActiveLocale() === catalogLocale && getFormattingLocale() === formattingLocale) return;
  setActiveLocale(catalogLocale, formattingLocale);
  for (const listener of listeners) listener();
}

export function applyLanguageSetting(language = String(settingValue("language") ?? DEFAULT_LOCALE)): Promise<void> {
  const resolved = resolveLocaleSelection(language, systemLocales(), SUPPORTED_LOCALES, DEFAULT_LOCALE);
  requestedCatalogLocale = resolved.catalogLocale;
  requestedFormattingLocale = resolved.formattingLocale;
  return whenLocaleReady();
}

export function whenLocaleReady(): Promise<void> {
  const catalogLocale = requestedCatalogLocale;
  const formattingLocale = requestedFormattingLocale;
  return loadLocale(catalogLocale).then(() => activateLocale(catalogLocale, formattingLocale));
}

export function startI18n(): void {
  if (started) return;
  started = true;
  effect(() => {
    const language = String(settingValue("language") ?? DEFAULT_LOCALE);
    void applyLanguageSetting(language);
  });
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
