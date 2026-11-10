import { Suspense, use, type ReactNode } from "react";

import { createComposerImageThumbnail } from "../../lib/imageCompression";

interface ThumbnailProps {
  file: File | null;
  src: string;
  alt: string;
  className: string;
  fallback: ReactNode;
}

function Thumbnail({ file, alt, className, fallback }: ThumbnailProps & { file: File }) {
  const src = use(createComposerImageThumbnail(file));
  return src ? <img src={src} alt={alt} className={className} /> : fallback;
}

/** Downscale local images; restored drafts preview the uploaded image. */
export function ComposerImageThumbnail(props: ThumbnailProps) {
  if (!props.file)
    return props.src ? (
      <img src={props.src} alt={props.alt} className={props.className} />
    ) : (
      props.fallback
    );
  return (
    <Suspense fallback={props.fallback}>
      <Thumbnail {...props} file={props.file} />
    </Suspense>
  );
}
