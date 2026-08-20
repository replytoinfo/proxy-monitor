import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    MAX_ADD_BODY_BYTES: 10_000,
    MAX_PROXIES: 100,
  },
}));

const { parseProxy, parseProxyList, hasStrayCredentialText } = await import("../parser.js");

describe("host validation", () => {
  it("rejects a host with a label glued in front of it", () => {
    expect(parseProxy("lv1 node-7x2k.eu.provider.example:11084:user:pass")).toBeNull();
    expect(parseProxy("cz1 proxy-prod-2a.provider.example:11083")).toBeNull();
  });

  it("rejects hosts with spaces, underscores or trailing dots", () => {
    expect(parseProxy("exa mple.com:8080")).toBeNull();
    expect(parseProxy("bad_host.com:8080")).toBeNull();
    expect(parseProxy("example.com.:8080")).toBeNull();
    expect(parseProxy("-example.com:8080")).toBeNull();
  });

  it("still accepts normal hosts and IPv4", () => {
    expect(parseProxy("example.com:8080")?.host).toBe("example.com");
    expect(parseProxy("proxy-prod-1a.provider.example:11081")?.host).toBe(
      "proxy-prod-1a.provider.example"
    );
    expect(parseProxy("1.2.3.4:1080")?.host).toBe("1.2.3.4");
    expect(parseProxy("socks5://node-7x2k.eu.provider.example:11084:u:p")?.type).toBe("socks5");
  });
});

describe("parseProxyList", () => {
  it("reports unparsable lines instead of dropping them silently", () => {
    const { valid, invalid } = parseProxyList(
      ["1.2.3.4:1080", "lv1 example.com:8080", "мусор", "# комментарий", ""].join("\n")
    );

    expect(valid).toHaveLength(1);
    expect(valid[0].host).toBe("1.2.3.4");
    expect(invalid).toEqual(["lv1 example.com:8080", "мусор"]);
  });

  it("returns an empty report for empty input", () => {
    expect(parseProxyList("")).toEqual({ valid: [], invalid: [] });
  });
});

describe("hasStrayCredentialText", () => {
  const parse = (line: string) => {
    const parsed = parseProxy(line);
    if (!parsed) throw new Error(`line must parse for this test: ${line}`);
    return parsed;
  };

  // Реальный инцидент 2026-08-08: из панели провайдера скопировалась метка
  // локации, последняя группа регекса жадная — хвост осел в пароле,
  // прокси залипла на "Socks5 Authentication failed".
  it("flags a location tag glued to the password", () => {
    expect(
      hasStrayCredentialText(
        parse("socks5://proxy-prod-1a.provider.example:11080:admin:k4m9x2qp70rt13 [DE1]")
      )
    ).toBe(true);
  });

  it("flags brackets without a space and stray text in the username", () => {
    expect(hasStrayCredentialText(parse("socks5://example.com:1080:admin:pass[DE1]"))).toBe(
      true
    );
    expect(hasStrayCredentialText(parse("socks5://example.com:1080:ad min:passwd"))).toBe(
      true
    );
  });

  it("stays quiet on passwords that merely look messy", () => {
    expect(
      hasStrayCredentialText(parse("socks5://proxy-prod-1a.provider.example:11082:admin:a1b2c3d4e5f6g7"))
    ).toBe(false);
    expect(
      hasStrayCredentialText(parse("socks5://example.com:1080:admin:p@ss:w0rd-!#$%"))
    ).toBe(false);
  });

  it("stays quiet when there are no credentials at all", () => {
    expect(hasStrayCredentialText(parse("1.2.3.4:1080"))).toBe(false);
  });
});
