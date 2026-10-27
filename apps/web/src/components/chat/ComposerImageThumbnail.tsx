import { Suspense, use, type ReactNode } from "react";

import { createComposerImageThumbnail } from "../../lib/imageCompression";

interface ThumbnailProps {
  file: File;
  alt: string;
  className: string;
  fallback: ReactNode;
}

function Thumbnail({ file, alt, className, fallback }: ThumbnailProps) {
  const src = use(createComposerImageThumbnail(file));
  return src ? <img src={src} alt={alt} className={className} /> : fallback;
}

/** A downscaled preview of an image file, so the composer never decodes the full image. */
export function ComposerImageThumbnail(props: ThumbnailProps) {
  return (
    <Suspense fallback={props.fallback}>
      <Thumbnail {...props} />
    </Suspense>
  );
}
