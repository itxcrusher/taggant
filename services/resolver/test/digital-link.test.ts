import { describe, expect, it } from "vitest";
import { DigitalLinkError, ancestry, checkDigit, parseDigitalLink } from "../src/digital-link.js";

describe("checkDigit", () => {
  it("agrees with published GS1 examples", () => {
    // The check digit is the last character, so it is computed over everything before it.
    expect(checkDigit("0952012345678")).toBe(8);
    expect(checkDigit("952012345678")).toBe(8);
  });
});

describe("parseDigitalLink", () => {
  it("reads a plain GTIN", () => {
    const link = parseDigitalLink("/01/09520123456788");
    expect(link.primary).toEqual({ ai: "01", value: "09520123456788" });
    expect(link.qualifiers).toEqual([]);
    expect(link.canonicalPath).toBe("/01/09520123456788");
  });

  it("reads the alphabetic form the standard also allows", () => {
    const link = parseDigitalLink("/gtin/09520123456788/lot/ABC/ser/12345");
    expect(link.primary.ai).toBe("01");
    expect(link.qualifiers.map((q) => q.ai)).toEqual(["10", "21"]);
    // Canonical means numeric, whichever form came in.
    expect(link.canonicalPath).toBe("/01/09520123456788/10/ABC/21/12345");
  });

  it("keeps whatever came before the identifiers, which the standard allows", () => {
    const link = parseDigitalLink("/some/shop/01/09520123456788");
    expect(link.prefix).toBe("some/shop");
    expect(link.canonicalPath).toBe("/some/shop/01/09520123456788");
  });

  it("tolerates a trailing slash", () => {
    expect(parseDigitalLink("/01/09520123456788/").canonicalPath).toBe("/01/09520123456788");
  });

  it("refuses a wrong check digit", () => {
    expect(() => parseDigitalLink("/01/09520123456789")).toThrow(DigitalLinkError);
    expect(() => parseDigitalLink("/01/09520123456789")).toThrow(/check digit/);
  });

  it("refuses a value that is the wrong shape for its identifier", () => {
    expect(() => parseDigitalLink("/01/notagtin")).toThrow(/not a valid value/);
  });

  it("refuses a qualifier that does not belong to the primary key", () => {
    // 8011 is a qualifier, but for CPID, not for GTIN.
    expect(() => parseDigitalLink("/01/09520123456788/8011/5")).toThrow(/not a key qualifier/);
  });

  it("refuses qualifiers in the wrong order, because the order is part of the meaning", () => {
    expect(() => parseDigitalLink("/01/09520123456788/21/12345/10/ABC")).toThrow(/out of order/);
  });

  it("refuses an identifier with no value", () => {
    expect(() => parseDigitalLink("/01/09520123456788/10")).toThrow(/followed by a value/);
  });

  it("refuses a path with no identifier at all", () => {
    expect(() => parseDigitalLink("/hello/world")).toThrow(/no primary identifier/);
    expect(() => parseDigitalLink("/")).toThrow(/holds no identifier/);
  });
});

describe("ancestry", () => {
  it("lists every level up to the primary key, most specific first", () => {
    expect(ancestry(parseDigitalLink("/01/09520123456788/10/ABC/21/12345"))).toEqual([
      "/01/09520123456788/10/ABC/21/12345",
      "/01/09520123456788/10/ABC",
      "/01/09520123456788",
    ]);
  });
});
