import { type Locale } from "@t45/contracts/models/User";
import { useSyncExternalStore } from "react";

import { de, type Message } from "./de";
import { it } from "./it";

export type { Message } from "./de";

export const localeNames = {
  en: "English",
  de: "Deutsch",
  it: "Italiano",
} as const satisfies Record<Locale, string>;

const catalogs = { en: null, de, it };

function detectLocale(): Locale {
  for (const language of globalThis.navigator?.languages ?? []) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "en" || base === "de" || base === "it") return base;
  }
  return "en";
}

let locale: Locale = detectLocale();
let localePreference: Locale | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getLocale = () => locale;
const getLocalePreference = () => localePreference;

export function setLocale(preference: Locale | null = null) {
  const selected = preference ?? detectLocale();
  const root = globalThis.document?.documentElement;
  if (root !== undefined) root.lang = selected;
  if (locale === selected && localePreference === preference) return;
  locale = selected;
  localePreference = preference;
  for (const listener of listeners) listener();
}

export type Translate = (message: Message, ...values: ReadonlyArray<unknown>) => string;

function makeTranslator(language: Locale): Translate {
  const catalog = catalogs[language];
  return (message, ...values) => {
    const template = catalog?.[message] ?? message;
    return values.length === 0
      ? template
      : template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
          Number(index) < values.length ? String(values[Number(index)]) : placeholder,
        );
  };
}

const translators = {
  en: makeTranslator("en"),
  de: makeTranslator("de"),
  it: makeTranslator("it"),
};

/** For UI messages emitted outside React, such as async mutation errors. */
export const translate: Translate = (message, ...values) => translators[locale](message, ...values);

export const useLocale = () => useSyncExternalStore(subscribe, getLocale);
export const useLocalePreference = () => useSyncExternalStore(subscribe, getLocalePreference);
export const useTranslation = () => translators[useLocale()];

export function translateChoices<Key extends string>(
  t: Translate,
  choices: Readonly<Record<Key, Message>>,
) {
  return Object.fromEntries(
    Object.entries<Message>(choices).map(([key, message]) => [key, t(message)]),
  ) as Readonly<Record<Key, string>>;
}
