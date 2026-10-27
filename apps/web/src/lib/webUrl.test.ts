import { describe, expect, it } from "vite-plus/test";

import { isImagePath, webUrlFileName, webUrlHost } from "./webUrl";

describe("isImagePath", () => {
  it.each([
    ["https://cdn.example/clip.webp?download=1#t=2", true],
    ["https://example.com/download?name=recording.mp4", false],
    ["https://example.png", false],
    ["images%2Fresult%2Epng", true],
    ["images/result%23v2.png", true],
    ["images/result.png%23secret.txt", false],
    ["images/result.png%3Fsecret.txt", false],
    ["/tmp/100%.png", true],
  ])("classifies the decoded pathname of %s", (source, expected) => {
    expect(isImagePath(source)).toBe(expected);
  });
});

describe("webUrlHost", () => {
  it.each([
    ["https://example.com", "example.com"],
    ["http://localhost:3000/path", "localhost"],
    ["//cdn.example.com/clip.mp4?signature=abc#t=2", "cdn.example.com"],
    ["//", null],
    ["#details", null],
    ["mailto:hello@example.com", null],
    ["file:///tmp/example.txt", null],
    ["javascript:void(0)", null],
    ["not a URL", null],
    [undefined, null],
  ])("reads the host of %s as %s", (href, expected) => {
    expect(webUrlHost(href)).toBe(expected);
  });
});

describe("webUrlFileName", () => {
  it.each([
    ["//cdn.example/clip%20one%2Emp4?sig=a+b#t=2", "clip one.mp4"],
    ["https://cdn.example/clip%2520.mp4", "clip%20.mp4"],
    ["https://cdn.example/clip%20%oops.mp4", "clip%20%oops.mp4"],
  ])("names %s as %s", (url, name) => {
    expect(webUrlFileName(url)).toBe(name);
  });
});
