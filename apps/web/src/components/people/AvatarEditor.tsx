import { AVATAR_COLORS, type Avatar } from "@t45/contracts/models/Avatar";
import { CameraIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { imageDataUrl } from "../../lib/imageCompression";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AVATAR_COLOR_CLASSES, OrganizationAvatar, UserAvatar } from "./UserAvatar";

/**
 * A name and an avatar, for a user's profile and the organization's; each change saves as it is
 * made. Without an image, the avatar is the name's initial on a chosen color.
 */
export function AvatarEditor({
  name: savedName,
  avatar,
  logo = false,
  autoFocus,
  className,
  onSave,
}: {
  readonly name: string;
  readonly avatar: Avatar;
  /** The organization's: its image is a logo, kept whole, rather than a picture cropped square. */
  readonly logo?: boolean;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly onSave: (name: string, avatar: Avatar) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(savedName);
  const pictureLabel = logo ? "Change the logo" : "Change your picture";

  // Every save carries the typed name, so an avatar change can't undo a name still saving.
  const save = (next: Avatar) => onSave(name.trim() || savedName, next);

  const saveName = () => {
    if (name.trim() === "") setName(savedName);
    else if (name.trim() !== savedName) save(avatar);
  };

  const pickFile = (file: File | undefined) => {
    if (file === undefined) return;
    void imageDataUrl(file, { mode: logo ? "fit" : "crop" }).then(
      (url) => save({ kind: "image", url }),
      (cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't use that image",
          description: cause instanceof Error ? cause.message : undefined,
        }),
    );
  };

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <div className="flex items-center gap-4">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={pictureLabel}
                onClick={() => fileInput.current?.click()}
                className={cn(
                  "group relative flex shrink-0 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
                  logo ? "rounded-sm" : "rounded-full",
                )}
              />
            }
          >
            {logo ? (
              <OrganizationAvatar name={name} avatar={avatar} className="w-24 text-4xl" />
            ) : (
              <UserAvatar name={name} avatar={avatar} size="lg" />
            )}
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                logo ? "rounded-sm" : "rounded-full",
              )}
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
          <TooltipPopup side="bottom">{pictureLabel}</TooltipPopup>
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
        <Field label={logo ? "Organization name" : "Your name"} className="min-w-0 flex-1">
          <Input
            autoFocus={autoFocus}
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
      {avatar.kind === "image" ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => save({ kind: "initial", color: "slate" })}
          >
            <Trash2Icon />
            Remove picture
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label>{logo ? "Its initial on a color" : "Your initial on a color"}</Label>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={option}
                aria-pressed={option === avatar.color}
                onClick={() => save({ kind: "initial", color: option })}
                className={`${AVATAR_COLOR_CLASSES[option]} size-6 rounded-full outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-foreground`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
