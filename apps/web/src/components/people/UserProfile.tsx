import { AVATAR_COLORS, MAX_AVATAR_BYTES } from "@t45/contracts/models/User";
import type { UpdateProfileRequest } from "@t45/contracts/resources/Users";
import { CameraIcon, LogOutIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import { api } from "../../rpc/api";
import { squareImageDataUrl } from "../../lib/imageCompression";
import { toastFailure } from "../../state/query";
import { updateProfile, useProfile } from "../../state/users";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Section } from "../Section";
import { AVATAR_COLOR_CLASSES, UserAvatar, getAvatar } from "./UserAvatar";

/** The image cropped to a centered square and scaled down, as base64 PNG. */
async function squareImage(file: File) {
  const dataUrl = await squareImageDataUrl(file);
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if ((data.length * 3) / 4 > MAX_AVATAR_BYTES) throw new Error("That image is too large.");
  return data;
}

/** Edit the signed-in user's name and avatar; each change saves as it is made. */
export function UserProfile() {
  const fileInput = useRef<HTMLInputElement>(null);
  const profile = useProfile();
  const [name, setName] = useState(profile.displayName);
  const hasImage = profile.avatarContentType !== null;

  // Every save carries the typed name, so an avatar change can't undo a name still saving.
  const save = (avatar: UpdateProfileRequest["avatar"]) =>
    void updateProfile({ displayName: name.trim() || profile.displayName, avatar });

  const saveName = () => {
    if (name.trim() === "") setName(profile.displayName);
    else if (name.trim() !== profile.displayName) save({ kind: "keep" });
  };

  const pickFile = (file: File | undefined) => {
    if (file === undefined) return;
    void squareImage(file).then(
      (data) => save({ kind: "upload", contentType: "image/png", data }),
      (cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't use that image",
          description: cause instanceof Error ? cause.message : undefined,
        }),
    );
  };

  return (
    <>
      <div className="mt-6 flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Change your picture"
                  onClick={() => fileInput.current?.click()}
                  className="group relative shrink-0 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                />
              }
            >
              <UserAvatar name={name} avatar={getAvatar(profile)} size="lg" />
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                <CameraIcon className="size-6" />
              </span>
              <span
                aria-hidden
                className="absolute end-0 bottom-0 flex size-7 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm"
              >
                <CameraIcon className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">Change your picture</TooltipPopup>
          </Tooltip>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              pickFile(event.currentTarget.files?.[0]);
              // Picking the same file again, after removing it, must still upload it.
              event.currentTarget.value = "";
            }}
          />
          <Field label="Your name" className="min-w-0 flex-1">
            <Input
              autoFocus
              autoComplete="off"
              data-1p-ignore
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </Field>
        </div>
        {hasImage ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => save({ kind: "initial", color: profile.avatarColor })}
            >
              <Trash2Icon />
              Remove picture
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label>Your initial on a color</Label>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={option}
                  aria-pressed={option === profile.avatarColor}
                  onClick={() => save({ kind: "initial", color: option })}
                  className={`${AVATAR_COLOR_CLASSES[option]} size-6 rounded-full outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-foreground`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <Sessions />
    </>
  );
}

function Sessions() {
  const [busy, startTransition] = useTransition();
  const signOutElsewhere = () =>
    startTransition(async () => {
      try {
        await api("users.signOutElsewhere", undefined);
        toastManager.add({ type: "success", title: "Signed out everywhere else" });
      } catch (cause) {
        toastFailure("Sign-out failed", cause);
      }
    });
  return (
    <Section
      title="Sessions"
      description="Stay signed in here and sign out of every other browser."
    >
      <div>
        <Button variant="destructive-outline" disabled={busy} onClick={signOutElsewhere}>
          <LogOutIcon />
          Sign out everywhere else
        </Button>
      </div>
    </Section>
  );
}
