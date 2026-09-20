import { describe, it, expect } from "vitest";
import { qualityIcon, formatQualityTail, formatSpanLabel } from "../quality-format.js";

describe("qualityIcon", () => {
  it("зелёный от 99% и выше", () => {
    expect(qualityIcon(100)).toBe("\u{1F7E2}");
    expect(qualityIcon(99)).toBe("\u{1F7E2}");
  });

  it("жёлтый от 95% до 99%", () => {
    expect(qualityIcon(98.9)).toBe("\u{1F7E1}");
    expect(qualityIcon(95)).toBe("\u{1F7E1}");
  });

  it("красный ниже 95%", () => {
    expect(qualityIcon(94.9)).toBe("\u{1F534}");
    expect(qualityIcon(77)).toBe("\u{1F534}");
  });
});

describe("formatQualityTail", () => {
  it("округляет процент до целого", () => {
    expect(formatQualityTail(77.4)).toBe(" · 77%");
    expect(formatQualityTail(96.5)).toBe(" · 97%");
  });

  it("показывает 100% только при полном отсутствии сбоев", () => {
    expect(formatQualityTail(100)).toBe(" · 100%");
  });

  it("ничего не показывает, когда данных нет", () => {
    expect(formatQualityTail(undefined)).toBe("");
  });

  it("не округляет проблемную прокси до 100%", () => {
    // 99.6% округлилось бы до 100 и спрятало сбои — для «почти сотни» нужен потолок 99.
    expect(formatQualityTail(99.94)).toBe(" · 99%");
  });
});

describe("formatSpanLabel", () => {
  it("36ч → «1д» (округление вниз)", () => {
    expect(formatSpanLabel(36)).toBe("1д");
  });

  it("12ч → «12ч»", () => {
    expect(formatSpanLabel(12)).toBe("12ч");
  });

  it("168ч → «7д»", () => {
    expect(formatSpanLabel(168)).toBe("7д");
  });

  it("0ч → «<1ч» (дробный охват меньше часа)", () => {
    expect(formatSpanLabel(0)).toBe("<1ч");
  });

  it("0.5ч → «<1ч»", () => {
    expect(formatSpanLabel(0.5)).toBe("<1ч");
  });

  it("1ч → «1ч» (ровно один час)", () => {
    expect(formatSpanLabel(1)).toBe("1ч");
  });

  it("23ч → «23ч» (не доросло до суток)", () => {
    expect(formatSpanLabel(23)).toBe("23ч");
  });
});
