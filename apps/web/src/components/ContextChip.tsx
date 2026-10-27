import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { CircleDashedIcon, FileIcon, ImageIcon } from "lucide-react";
import { type ComponentProps, type CSSProperties, type ReactElement, useState } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The inline pill for one piece of chat context (an image or file) that sits in
 * running text, both in the composer and in sent messages; `.context-chip` in index.css draws
 * it. It lives with the chat components rather than in components/ui because it is one
 * feature's look, not a generic primitive.
 *
 * Renders a span by default. Render it as a button, link or popover/tooltip trigger to make it
 * interactive; the hover tint follows from that, not from a prop. Anything focusable (including a
 * span with tabIndex for a tooltip) gets the focus outline. A consumer may override
 * `--context-chip-accent` through `style` for a color that comes from content, such as an
 * image's average color.
 */
export function ContextChip({
  kind,
  state,
  render,
  ...props
}: useRender.ComponentProps<"span"> & {
  kind?: "image" | "file" | undefined;
  state?: "unresolved" | "invalid" | undefined;
}) {
  const chipProps = { className: "context-chip", "data-kind": kind, "data-state": state };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(chipProps, props),
    render,
  });
}

/** The chip's text. Truncates to the chip's width. */
function ContextChipLabel({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("block min-w-0 self-center truncate leading-tight", className)}
      {...props}
    />
  );
}

export function ChipTooltip(props: { tooltip: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {props.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Sample the loaded thumbnail once; transparent pixels should not darken its accent. */
function averageImageColor(image: HTMLImageElement): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, 16, 16);
    const { data } = context.getImageData(0, 0, 16, 16);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (let index = 0; index < data.length; index += 4) {
      const weight = data[index + 3]!;
      red += data[index]! * weight;
      green += data[index + 1]! * weight;
      blue += data[index + 2]! * weight;
      alpha += weight;
    }
    if (alpha === 0) return;
    return `rgb(${Math.round(red / alpha)} ${Math.round(green / alpha)} ${Math.round(blue / alpha)})`;
  } catch {
    // Unavailable pixels keep the default image tone and preview action.
    return;
  }
}

/** Name, size and status after an attachment chip's icon. A long name gives way in its middle. */
function AttachmentChipText(props: {
  name: string;
  size: string;
  suffix: string | null | undefined;
}) {
  const characters = Array.from(props.name);
  return (
    <>
      <ContextChipLabel className="flex max-w-72">
        <span className="min-w-0 truncate">{characters.slice(0, -14).join("")}</span>
        <span className="shrink-0">{characters.slice(-14).join("")}</span>
      </ContextChipLabel>
      <span className="shrink-0 text-3xs text-current">{props.size}</span>
      {props.suffix ? <span className="text-3xs text-current">{props.suffix}</span> : null}
    </>
  );
}

export function ImageChipButton({
  name,
  previewUrl,
  size,
  suffix,
  ...props
}: Omit<ComponentProps<typeof ContextChip>, "kind" | "render"> & {
  name: string;
  previewUrl: string | undefined;
  size: string;
  suffix?: string | null;
}) {
  const [sample, setSample] = useState<{ url: string; color: string | undefined }>();
  const accent = sample?.url === previewUrl ? sample?.color : undefined;
  return (
    <ContextChip
      kind="image"
      render={<button type="button" />}
      aria-label={`Image attachment, ${name}, ${size}`}
      style={accent ? ({ "--context-chip-accent": accent } as CSSProperties) : undefined}
      {...props}
    >
      {previewUrl ? (
        <img
          key={previewUrl}
          src={previewUrl}
          alt=""
          className="size-[1.17em] shrink-0 rounded-sm object-cover"
          onLoad={(event) =>
            setSample({ url: previewUrl, color: averageImageColor(event.currentTarget) })
          }
        />
      ) : (
        <ImageIcon />
      )}
      <AttachmentChipText name={name} size={size} suffix={suffix} />
    </ContextChip>
  );
}

export function FileChip(props: {
  name: string;
  size: string;
  tooltip: string;
  suffix?: string | null;
  error?: boolean;
  unresolved?: boolean;
  href?: string;
}) {
  return (
    <ChipTooltip tooltip={props.tooltip}>
      <ContextChip
        kind="file"
        state={props.unresolved ? "unresolved" : props.error ? "invalid" : undefined}
        render={props.href ? <a href={props.href} download={props.name} /> : undefined}
        tabIndex={props.href ? undefined : 0}
        aria-label={[`File attachment, ${props.name}, ${props.size}`, props.suffix]
          .filter(Boolean)
          .join(", ")}
      >
        <FileIcon />
        <AttachmentChipText name={props.name} size={props.size} suffix={props.suffix} />
      </ContextChip>
    </ChipTooltip>
  );
}

export function UnresolvedChip(props: { label: string; tooltip: string }) {
  return (
    <ChipTooltip tooltip={props.tooltip}>
      <ContextChip
        state="unresolved"
        tabIndex={0}
        aria-label={`Unavailable context, ${props.label}`}
      >
        <CircleDashedIcon />
        <ContextChipLabel>{props.label}</ContextChipLabel>
      </ContextChip>
    </ChipTooltip>
  );
}
