/** BCP-47 primary subtags we ship. Keep this list small and evaluated; adding a tag is a product decision. */
export const LANGUAGES = {
  en: { name: "English", native: "English" },
  hi: { name: "Hindi", native: "हिन्दी" },
  ml: { name: "Malayalam", native: "മലയാളം" },
  es: { name: "Spanish", native: "Español" },
  fr: { name: "French", native: "Français" },
  de: { name: "German", native: "Deutsch" },
  ja: { name: "Japanese", native: "日本語" },
  pt: { name: "Portuguese", native: "Português" },
} as const;

export type LanguageCode = keyof typeof LANGUAGES;
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as LanguageCode[];

export function isLanguageCode(x: string): x is LanguageCode {
  return x in LANGUAGES;
}
