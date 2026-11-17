import { describe, expect, it } from "vite-plus/test";

import { formatDay, formatNumber } from "./workLogic";

describe("formatDay", () => {
  it("leaves the year out for this year's dates only", () => {
    const year = new Date().getFullYear();
    expect(formatDay(`${year}-10-27`)).not.toContain(String(year));
    expect(formatDay(`${year + 1}-01-05`)).toContain(String(year + 1));
  });
});

describe("formatNumber", () => {
  it("shows exactly the decimals a field sets, and the value as stored otherwise", () => {
    expect(formatNumber(47.6, { decimals: 2 })).toBe("47,60");
    expect(formatNumber(2.143333, { decimals: 2 })).toBe("2,14");
    expect(formatNumber(43.0016, { decimals: 0 })).toBe("43");
    expect(formatNumber(1.24375, {})).toBe("1,24375");
    expect(formatNumber(1234.5, { decimals: 2 })).toBe("1234,50");
  });

  it("shows one more decimal below 1, so small amounts still differ", () => {
    expect(formatNumber(0.0566, { decimals: 2, unit: "€" })).toBe("0,057 €");
    expect(formatNumber(0, { decimals: 2 })).toBe("0,00");
  });

  it("sets a percent sign against the number and other units a space after it", () => {
    expect(formatNumber(43, { decimals: 1, unit: "%" })).toBe("43,0%");
    expect(formatNumber(47.6, { decimals: 2, unit: "€" })).toBe("47,60 €");
  });
});
