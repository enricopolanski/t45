import { Locale } from "@t45/contracts/models/User";
import { GlobeIcon, LogOutIcon } from "lucide-react";
import { useTransition } from "react";

import { localeNames, setLocale, useLocalePreference, useTranslation } from "~/i18n/locale";
import { api } from "../../rpc/api";
import { toastFailure } from "../../state/query";
import { updateProfile, useProfile } from "../../state/users";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Section } from "../Section";
import { AvatarEditor } from "./AvatarEditor";

/** Edit the signed-in user's name and avatar. */
export function UserProfile() {
  const profile = useProfile();
  return (
    <>
      <AvatarEditor
        className="mt-6"
        name={profile.displayName}
        avatar={profile.avatar}
        autoFocus
        onSave={(displayName, avatar) => void updateProfile({ displayName, avatar })}
      />
      <LanguageSettings />
      <Sessions />
    </>
  );
}

type LocaleChoice = Locale | "browser";

const localeFlags = {
  en: "/flags/gb.svg",
  de: "/flags/de.svg",
  it: "/flags/it.svg",
} satisfies Record<Locale, string>;

function LocaleLabel({ value, browserLabel }: { value: LocaleChoice; browserLabel: string }) {
  return (
    <span
      lang={value === "browser" ? undefined : value}
      className="flex min-w-0 items-center gap-2.5"
    >
      {value === "browser" ? (
        <span aria-hidden="true" className="flex w-5 shrink-0 justify-center">
          <GlobeIcon className="size-4 text-muted-foreground" />
        </span>
      ) : (
        <img
          src={localeFlags[value]}
          alt=""
          className="h-3.5 w-5 shrink-0 rounded-xs ring-1 ring-border"
        />
      )}
      <span className="truncate">{value === "browser" ? browserLabel : localeNames[value]}</span>
    </span>
  );
}

function LanguageSettings() {
  const t = useTranslation();
  const choice = useLocalePreference() ?? "browser";
  const [isSaving, startSaving] = useTransition();
  const browserLabel = t("Browser language");

  const saveLocale = (next: LocaleChoice | null) => {
    if (next === null || next === choice) return;
    const locale = next === "browser" ? null : next;
    startSaving(async () => {
      try {
        await api("users.setLocale", { locale });
        setLocale(locale);
      } catch (cause) {
        toastFailure(t("Couldn't change the language"), cause);
      }
    });
  };

  return (
    <Section title={t("Language")}>
      <Select<LocaleChoice> value={choice} onValueChange={saveLocale} disabled={isSaving}>
        <SelectTrigger
          size="sm"
          className="w-52 max-w-full min-w-0 self-start"
          aria-label={t("Interface language")}
        >
          <SelectValue>
            {(value: LocaleChoice) => <LocaleLabel value={value} browserLabel={browserLabel} />}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="browser">
            <LocaleLabel value="browser" browserLabel={browserLabel} />
          </SelectItem>
          {Locale.literals.map((value) => (
            <SelectItem key={value} value={value} lang={value}>
              <LocaleLabel value={value} browserLabel={browserLabel} />
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Section>
  );
}

function Sessions() {
  const t = useTranslation();
  const [busy, startTransition] = useTransition();
  const signOutElsewhere = () =>
    startTransition(async () => {
      try {
        await api("users.signOutElsewhere", undefined);
        toastManager.add({ type: "success", title: t("Signed out everywhere else") });
      } catch (cause) {
        toastFailure(t("Sign-out failed"), cause);
      }
    });
  return (
    <Section
      title={t("Sessions")}
      description={t("Stay signed in here and sign out of every other browser.")}
    >
      <div>
        <Button variant="destructive-outline" disabled={busy} onClick={signOutElsewhere}>
          <LogOutIcon />
          {t("Sign out everywhere else")}
        </Button>
      </div>
    </Section>
  );
}
