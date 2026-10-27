import {
  AVATAR_COLORS,
  type AvatarColor,
  MAX_AVATAR_BYTES,
  type Avatar,
} from "@t45/contracts/models/User";
import type { UpdateProfileRequest } from "@t45/contracts/resources/Users";
import { useId, useState, useTransition } from "react";

import { signOut } from "../../http/auth";
import { api } from "../../rpc/api";
import { describeFailure } from "../../lib/failures";
import { squareImageDataUrl } from "../../lib/imageCompression";
import { toastFailure } from "../../state/query";
import { useProfile } from "../../state/users";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ErrorText } from "../ui/error-text";
import { toastManager } from "../ui/toast";
import { Section } from "../Section";
import { AVATAR_COLOR_CLASSES, UserAvatar, getAvatar } from "./UserAvatar";

type AvatarChoice = "current" | "initial" | "clerk" | "upload";

/** An uploaded image, made a square of at most this many pixels a side before it is sent. */
const UPLOAD_SIDE = 256;

interface Upload {
  readonly data: string;
  readonly previewUrl: string;
}

/** The image cropped to a centered square and scaled down, as base64 JPEG. */
async function squareImage(file: File) {
  const previewUrl = await squareImageDataUrl(file, UPLOAD_SIDE, "image/jpeg", 0.9);
  const data = previewUrl.slice(previewUrl.indexOf(",") + 1);
  if ((data.length * 3) / 4 > MAX_AVATAR_BYTES) throw new Error("That image is too large.");
  return { data, previewUrl };
}

/** Edit the signed-in user's name and avatar. */
export function UserProfile() {
  const id = useId();
  const profile = useProfile();
  const [name, setName] = useState(profile.displayName);
  const [choice, setChoice] = useState<AvatarChoice>(
    profile.avatarContentType === null ? "initial" : "current",
  );
  const [color, setColor] = useState<AvatarColor>(profile.avatarColor);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const preview: Avatar =
    choice === "current"
      ? getAvatar(profile)
      : choice === "clerk" && profile.clerkImageUrl
        ? { kind: "image", url: profile.clerkImageUrl }
        : choice === "upload" && upload !== null
          ? { kind: "image", url: upload.previewUrl }
          : { kind: "initial", color };

  const pickFile = (file: File | undefined) => {
    if (file === undefined) return;
    setError(null);
    void squareImage(file).then(
      (prepared) => {
        setUpload(prepared);
        setChoice("upload");
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "That image can't be used."),
    );
  };

  const save = () => {
    const avatar: UpdateProfileRequest["avatar"] =
      choice === "current"
        ? { kind: "keep" }
        : choice === "clerk"
          ? { kind: "clerk" }
          : choice === "upload" && upload !== null
            ? { kind: "upload", contentType: "image/jpeg", data: upload.data }
            : { kind: "initial", color };
    startSaving(async () => {
      setError(null);
      try {
        await api("users.updateProfile", { displayName: name.trim(), avatar });
        // A fresh load, so every page reads the new name and avatar.
        window.location.assign("/");
      } catch (cause) {
        setError(describeFailure(cause));
      }
    });
  };

  return (
    <>
      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex items-center gap-4">
          <UserAvatar name={name} avatar={preview} size="lg" />
          <Field label="Your name" className="min-w-0 flex-1">
            <Input
              autoFocus
              required
              pattern=".*\S.*"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </Field>
        </div>
        <RadioGroup
          aria-label="Avatar"
          value={choice}
          onValueChange={(value) =>
            setChoice(
              value === "current" || value === "clerk" || value === "upload" ? value : "initial",
            )
          }
        >
          {profile.avatarContentType === null ? null : (
            <div className="flex items-center gap-2">
              <Radio id={`${id}-current`} value="current" />
              <Label htmlFor={`${id}-current`}>Current image</Label>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Radio id={`${id}-initial`} value="initial" />
              <Label htmlFor={`${id}-initial`}>Your initial on a color</Label>
            </div>
            {choice === "initial" ? (
              <div className="flex flex-wrap gap-2 ps-6">
                {AVATAR_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    aria-pressed={option === color}
                    onClick={() => setColor(option)}
                    className={`${AVATAR_COLOR_CLASSES[option]} size-6 rounded-full outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-foreground`}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {profile.clerkImageUrl === null ? null : (
            <div className="flex items-center gap-2">
              <Radio id={`${id}-clerk`} value="clerk" />
              <Label htmlFor={`${id}-clerk`}>The picture from your account</Label>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Radio id={`${id}-upload`} value="upload" disabled={upload === null} />
            <Label htmlFor={`${id}-file`}>An image of your own</Label>
            <input
              id={`${id}-file`}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload an image"
              className="min-w-0 text-xs text-muted-foreground"
              onChange={(event) => pickFile(event.currentTarget.files?.[0])}
            />
          </div>
        </RadioGroup>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
      <Sessions />
    </>
  );
}

function Sessions() {
  const [busy, startTransition] = useTransition();
  const run = (action: () => Promise<unknown>) =>
    startTransition(async () => {
      try {
        await action();
      } catch (cause) {
        toastFailure("Sign-out failed", cause);
      }
    });
  return (
    <Section
      title="Sessions"
      description="Sign out of this browser, or stay signed in here and sign out everywhere else."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(signOut)}>
          Sign out
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(() =>
              api("users.signOutElsewhere", undefined).then(() =>
                toastManager.add({ type: "success", title: "Signed out everywhere else" }),
              ),
            )
          }
        >
          Sign out everywhere else
        </Button>
      </div>
    </Section>
  );
}
