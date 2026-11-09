import { describe, expect, it } from "vite-plus/test";

import { formatDueDate } from "./workLogic";

describe("formatDueDate", () => {
  it("leaves the year out for this year's dates only", () => {
    const year = new Date().getFullYear();
    expect(formatDueDate(`${year}-10-27`)).not.toContain(String(year));
    expect(formatDueDate(`${year + 1}-01-05`)).toContain(String(year + 1));
  });
});
