import { describe, expect, it } from "vitest";
import { DigitalLinkError, ancestry, checkDigit, parseDigitalLink } from "../src/digital-link.js";

describe("checkDigit", () => {
  it("agrees with published GS1 examples", () => {
    // The check digit is the last character, so it is computed over everything before it.
    // Leading zeros do not change it, which is what makes padding a GTIN safe.
    expect(checkDigit("0952012345678")).toBe(8);
    expect(checkDigit("952012345678")).toBe(8);
    // Different bodies, so this is not one number asserted twice.
    expect(checkDigit("61414100734")).toBe(9);
    expect(checkDigit("9520123")).toBe(8);
    expect(checkDigit("00000000000000")).toBe(0);
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

  it("keeps whatever came before the identifiers apart from them", () => {
    const link = parseDigitalLink("/some/shop/01/09520123456788");
    // The stem is where it belongs and the path is what the table is keyed on, so the same
    // product does not split into as many identifiers as there are paths in front of it.
    expect(link.stem).toBe("/some/shop");
    expect(link.canonicalPath).toBe("/01/09520123456788");
  });

  it("encodes the stem, which is the part a caller writes freely", () => {
    expect(parseDigitalLink('/a"b/01/09520123456788').stem).toBe("/a%22b");
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

describe("the forms a GTIN is printed in", () => {
  it("treats an EAN-13 and its fourteen digit form as the same identifier", () => {
    // This is the form actually printed on a pack, and GS1's own toolkit says both denote
    // the same GTIN. Keyed separately, a scan of a real code finds nothing.
    expect(parseDigitalLink("/01/9520123456788").canonicalPath).toBe("/01/09520123456788");
    expect(parseDigitalLink("/01/09520123456788").canonicalPath).toBe("/01/09520123456788");
  });

  it("does the same for the twelve and eight digit forms", () => {
    // A UPC-A and a GTIN-8, padded to the same fourteen digits.
    expect(parseDigitalLink("/01/614141007349").canonicalPath).toBe("/01/00614141007349");
    expect(parseDigitalLink("/01/95201238").canonicalPath).toBe("/01/00000095201238");
  });

  it("still refuses a wrong check digit in the shorter form", () => {
    expect(() => parseDigitalLink("/01/9520123456789")).toThrow(/check digit/);
  });
});

describe("key qualifier values", () => {
  it("refuses a lot number longer than the standard allows", () => {
    expect(() => parseDigitalLink(`/01/09520123456788/10/${"A".repeat(21)}`)).toThrow(/key qualifier 10/);
  });

  it("refuses characters the standard does not allow in a lot number", () => {
    expect(() => parseDigitalLink("/01/09520123456788/10/has space")).toThrow(/key qualifier 10/);
    expect(() => parseDigitalLink("/01/09520123456788/10/日本")).toThrow(/key qualifier 10/);
  });

  it("refuses letters where the standard says digits", () => {
    expect(() => parseDigitalLink("/8018/012345678901234560/8019/ABC")).toThrow(/key qualifier 8019/);
  });

  it("still accepts ordinary values", () => {
    expect(parseDigitalLink("/01/09520123456788/10/ABC-123").qualifiers[0]?.value).toBe("ABC-123");
    expect(parseDigitalLink("/8018/012345678901234560/8019/12345").qualifiers[0]?.value).toBe("12345");
  });
});
