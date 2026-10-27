import { useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { resolveProtocolRelativeUrl } from "~/lib/webUrl";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "~/components/chat/composerLayout";

export interface GalleryImage {
  src: string;
  name: string;
  /** The authored web URL, opened when the image cannot be loaded here. */
  url?: string;
}

export interface ImageGallery {
  images: GalleryImage[];
  index: number;
}

export function ImageUnavailableLabel({ alt }: { alt: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {alt.length > 0 ? `Image unavailable · ${alt}` : "Image unavailable"}
    </span>
  );
}

export function ExpandedImageDialog({
  gallery,
  onClose,
}: {
  gallery: ImageGallery;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(gallery.index);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  // The element that opened the preview gets focus back on close, which unmounts the dialog.
  // Without it focus stays on the removed dialog, and a composer that owned the opener reads
  // that as a blur and rests.
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const imageCount = gallery.images.length;
  const item = gallery.images[index];

  const navigateImage = (direction: -1 | 1) =>
    setIndex((current) => (current + direction + imageCount) % imageCount);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (imageCount <= 1 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(event.key === "ArrowLeft" ? -1 : 1);
  };

  if (!item) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded image preview</DialogTitle>
        {imageCount > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="absolute -bottom-12 left-0 z-20 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <div className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]">
          <Button
            type="button"
            ref={closeButtonRef}
            size="icon-xs"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <XIcon />
          </Button>
          {failedImageSrc === item.src ? (
            <div
              role="alert"
              className="flex h-48 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl"
            >
              <ImageUnavailableLabel alt={item.name} />
              {item.url ? (
                <Button
                  size="sm"
                  variant="secondary"
                  render={
                    <a
                      href={resolveProtocolRelativeUrl(item.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  <ExternalLinkIcon />
                  Open original
                </Button>
              ) : null}
            </div>
          ) : (
            <ZoomableImage
              ref={zoomableImageRef}
              key={`${index}:${item.src}`}
              src={item.src}
              name={item.name}
              onError={() => setFailedImageSrc(item.src)}
            />
          )}
          <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80">
            <span className="truncate" aria-live="polite" aria-atomic="true">
              {item.name}
              {imageCount > 1 ? ` (${index + 1}/${imageCount})` : ""}
            </span>
          </div>
        </div>
        {imageCount > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="absolute right-0 -bottom-12 z-20 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next media"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
}
