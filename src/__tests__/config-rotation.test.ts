import { describe, it, expect, beforeAll } from "vitest";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_CHAT_ID ??= "12345";
process.env.ENCRYPTION_KEY ??= "a".repeat(64);

let resolveRotationMaxAge: (maxAge: number, checkInterval: number) => number;
let validateCheckUrl: (raw: string) => URL | null;
let validateWatchdogUrl: (raw: string) => URL | null;
let parseEchoUrls: (raw: string) => string[];
let optionalFallbackUrl: (raw: string) => string | null;

beforeAll(async () => {
  const mod = await import("../config.js");
  resolveRotationMaxAge = mod.resolveRotationMaxAge;
  validateCheckUrl = mod.validateCheckUrl;
  validateWatchdogUrl = mod.validateWatchdogUrl;
  parseEchoUrls = mod.parseEchoUrls;
  optionalFallbackUrl = mod.optionalFallbackUrl;
});

describe("resolveRotationMaxAge", () => {
  it("keeps a value that is at least two check intervals", () => {
    expect(resolveRotationMaxAge(2_700_000, 300_000)).toBe(2_700_000);
  });

  it("raises a value below two check intervals", () => {
    expect(resolveRotationMaxAge(120_000, 300_000)).toBe(600_000);
  });

  it("keeps 0 as the disabled sentinel", () => {
    expect(resolveRotationMaxAge(0, 300_000)).toBe(0);
  });
});

describe("validateCheckUrl", () => {
  it("accepts an http url", () => {
    expect(validateCheckUrl("http://httpbin.org/status/200")?.hostname).toBe("httpbin.org");
  });

  it("rejects https", () => {
    expect(validateCheckUrl("https://httpbin.org/status/200")).toBeNull();
  });

  it("rejects a malformed url", () => {
    expect(validateCheckUrl("not a url")).toBeNull();
  });
});

describe("validateWatchdogUrl", () => {
  it("accepts https", () => {
    expect(validateWatchdogUrl("https://hc-ping.com/abc")?.protocol).toBe("https:");
  });

  it("accepts http", () => {
    expect(validateWatchdogUrl("http://hc-ping.com/abc")?.protocol).toBe("http:");
  });

  it("rejects a non-http scheme", () => {
    expect(validateWatchdogUrl("ftp://hc-ping.com/abc")).toBeNull();
  });
});

describe("parseEchoUrls", () => {
  it("splits, trims and normalizes", () => {
    expect(parseEchoUrls("http://api.ipify.org, http://ifconfig.me/ip")).toEqual([
      "http://api.ipify.org/",
      "http://ifconfig.me/ip",
    ]);
  });

  it("drops empty items and duplicates", () => {
    expect(parseEchoUrls(" http://a.test , ,http://a.test,http://b.test ")).toEqual([
      "http://a.test/",
      "http://b.test/",
    ]);
  });

  it("drops invalid items but keeps the valid ones", () => {
    expect(parseEchoUrls("https://a.test,not a url,http://b.test")).toEqual([
      "http://b.test/",
    ]);
  });

  it("returns an empty list when nothing is valid", () => {
    expect(parseEchoUrls("https://a.test,garbage")).toEqual([]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseEchoUrls("")).toEqual([]);
  });
});

describe("optionalFallbackUrl", () => {
  it("returns null silently for an empty string", () => {
    expect(optionalFallbackUrl("")).toBeNull();
  });

  it("returns null silently for a whitespace-only string", () => {
    expect(optionalFallbackUrl("   ")).toBeNull();
  });

  it("returns null with a warn for an invalid url", () => {
    expect(optionalFallbackUrl("not a url")).toBeNull();
  });

  it("accepts a valid http url", () => {
    expect(optionalFallbackUrl("http://gstatic.com/generate_204")).toBe(
      "http://gstatic.com/generate_204"
    );
  });
});
