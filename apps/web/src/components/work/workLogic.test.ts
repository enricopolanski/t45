import { describe, expect, it } from "vite-plus/test";

import { formatDay } from "./workLogic";

describe("formatDay", () => {
  it("leaves the year out for this year's dates only", () => {
    const year = new Date().getFullYear();
    expect(formatDay(`${year}-10-27`)).not.toContain(String(year));
    expect(formatDay(`${year + 1}-01-05`)).toContain(String(year + 1));
  });
});
