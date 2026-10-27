import { useEffect } from "react";

import { imageDataUrl } from "../lib/imageCompression";
import { useOrganizationIfLoaded } from "../state/organization";

/** The tab's icon: the organization's whole logo in 16 pixels, or T45's while it has none. */
export function useOrganizationFavicon() {
  const avatar = useOrganizationIfLoaded()?.avatar;
  const logoUrl = avatar?.kind === "image" ? avatar.url : null;
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon === null || logoUrl === null) return;
    const { href } = icon;
    const sizes = icon.getAttribute("sizes");
    let current = true;
    void fetch(logoUrl)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response)))
      .then((logo) => imageDataUrl(logo, { maxSide: 16, mode: "pad" }))
      .then(
        (dataUrl) => {
          if (!current) return;
          icon.href = dataUrl;
          icon.setAttribute("sizes", "16x16");
        },
        () => undefined,
      );
    return () => {
      current = false;
      icon.href = href;
      if (sizes !== null) icon.setAttribute("sizes", sizes);
    };
  }, [logoUrl]);
}
