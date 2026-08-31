import { describe, it, expect } from "vitest";
import { qualityIcon, formatQualityTail, formatWindow } from "../quality-format.js";

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

describe("formatWindow", () => {
  it("показывает часы, пока не набрались сутки", () => {
    expect(formatWindow(5)).toBe("за 5 часов");
  });

  it("показывает дни, когда набралось больше суток", () => {
    expect(formatWindow(72)).toBe("за 3 дня");
  });

  it("округляет вниз — окно не должно выглядеть полнее, чем есть", () => {
    expect(formatWindow(47)).toBe("за 1 день");
  });
});
