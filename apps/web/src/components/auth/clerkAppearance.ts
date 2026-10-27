import type { ClerkProviderProps } from "@clerk/react";

/** Keeps Clerk's stock component structure while binding its color system to the app's CSS
 * tokens. Passed to ClerkProvider, so every Clerk component under it gets it. */
export const clerkAppearance = {
  variables: {
    // Clerk reuses its primary color for filled buttons and bare links; the
    // card surface provides the inverse filled-control pair.
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--card)",
    colorDanger: "var(--destructive)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--foreground)",
    colorForeground: "var(--foreground)",
    // Clerk paints the card footer with this token: an opaque surface derived from the card.
    colorMuted: "color-mix(in srgb, var(--card) 98%, var(--foreground))",
    colorMutedForeground: "var(--muted-foreground)",
    colorBackground: "var(--card)",
    colorInputForeground: "var(--foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
  },
  elements: {
    formFieldErrorText: { color: "var(--destructive-foreground)" },
    formFieldWarningText: { color: "var(--warning-foreground)" },
    formFieldSuccessText: { color: "var(--success-foreground)" },
    otpCodeFieldErrorText: { color: "var(--destructive-foreground)" },
    otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
  },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
