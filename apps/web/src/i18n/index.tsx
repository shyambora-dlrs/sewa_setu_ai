/**
 * Minimal i18n: a typed dictionary per language, a React context and a `t` helper
 * with `{placeholder}` interpolation. The chosen language is remembered in
 * localStorage (wrapped in try/catch: storage can be blocked) and mirrored to
 * `<html lang>` so screen readers pick the right voice.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SUPPORTED_LANGUAGES, type Language } from "../../../../packages/shared/constants";
import { as } from "./as";
import { en, type Dictionary } from "./en";
import { hi } from "./hi";

const DICTS: Record<Language, Dictionary> = { en, hi, as };
export const LANGUAGE_LABELS: Record<Language, string> = { en: "English", hi: "हिन्दी", as: "অসমীয়া" };
const STORAGE_KEY = "sewasetu.lang";

interface I18nValue {
  lang: Language;
  setLang(l: Language): void;
  d: Dictionary;
  /** Replaces `{name}` placeholders: t("Page {p}", { p: 2 }). */
  t(template: string, vars?: Record<string, string | number>): string;
}
const I18nContext = createContext<I18nValue | null>(null);

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) return saved as Language;
  } catch { /* storage unavailable: fall through */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return nav === "hi" ? "hi" : nav === "as" ? "as" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(initialLanguage);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Language) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  }, []);
  const value = useMemo<I18nValue>(() => ({
    lang, setLang, d: DICTS[lang],
    t: (template, vars) => template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`)),
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
