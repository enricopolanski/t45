import { ChatId } from "@t45/contracts/models/Chat";
import { type CxOptions, cx } from "class-variance-authority";
import * as Hex from "effect/encoding/Hex";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's extra font sizes (index.css). Unregistered, tailwind-merge reads
// text-2xs as a colour and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Hand-rolled because crypto.randomUUID exists only in secure contexts, and T45 can be served
 * over plain HTTP.
 */
export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newChatId = (): ChatId => ChatId.make(randomUUID());
