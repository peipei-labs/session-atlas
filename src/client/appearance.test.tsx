import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceMenu } from "./AppearanceMenu";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
  parseAppearance,
  readAppearance,
} from "./appearance";

Object.assign(globalThis, { React });

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    store,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("appearance", () => {
  it("falls back to defaults for missing or corrupt storage", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("not-json")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"neon","shape":"star"}')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('"dot"')).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps a valid stored theme and drops unknown or removed fields", () => {
    expect(parseAppearance('{"theme":"light","shape":"dot"}')).toEqual({ theme: "light", shape: "dot" });
    expect(parseAppearance('{"theme":"dark"}')).toEqual({ theme: "dark", shape: "hex" });
    expect(parseAppearance('{"theme":"emerald"}')).toEqual({ theme: "emerald", shape: "hex" });
    expect(parseAppearance('{"theme":"sakura","shape":"dot"}')).toEqual({ theme: "sakura", shape: "dot" });
    expect(parseAppearance('{"theme":"light","shape":"star"}')).toEqual({ theme: "light", shape: "hex" });
    expect(parseAppearance('{"shape":"dot"}')).toEqual({ theme: "dark", shape: "dot" });
  });

  it("maps retired themes to their replacements", () => {
    expect(parseAppearance('{"theme":"midnight"}')).toEqual({ theme: "dark", shape: "hex" });
    expect(parseAppearance('{"theme":"sand"}')).toEqual({ theme: "light", shape: "hex" });
    expect(parseAppearance('{"theme":"sand","shape":"hex"}')).toEqual({ theme: "light", shape: "hex" });
  });

  it("rewrites the v2 entry when it holds a retired theme", () => {
    const storage = createStorage();
    storage.setItem(APPEARANCE_STORAGE_KEY, '{"theme":"sand","shape":"dot"}');
    vi.stubGlobal("window", { localStorage: storage });

    expect(readAppearance()).toEqual({ theme: "light", shape: "dot" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe('{"theme":"light","shape":"dot"}');
  });

  it("does not rewrite a current v2 entry", () => {
    const storage = createStorage();
    storage.setItem(APPEARANCE_STORAGE_KEY, '{"theme":"dark","shape":"hex"}');
    vi.stubGlobal("window", { localStorage: storage });

    expect(readAppearance()).toEqual({ theme: "dark", shape: "hex" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe('{"theme":"dark","shape":"hex"}');
  });

  it("migrates the v1 entry to v2, resolving retired themes and keeping the shape", () => {
    const storage = createStorage();
    storage.setItem(LEGACY_APPEARANCE_STORAGE_KEY, '{"theme":"sand","shape":"dot"}');
    vi.stubGlobal("window", { localStorage: storage });

    expect(readAppearance()).toEqual({ theme: "light", shape: "dot" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe('{"theme":"light","shape":"dot"}');
    expect(storage.getItem(LEGACY_APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  it("prefers the v2 entry over the legacy one", () => {
    const storage = createStorage();
    storage.setItem(APPEARANCE_STORAGE_KEY, '{"theme":"dark"}');
    storage.setItem(LEGACY_APPEARANCE_STORAGE_KEY, '{"theme":"sand","shape":"dot"}');
    vi.stubGlobal("window", { localStorage: storage });

    expect(readAppearance()).toEqual({ theme: "dark", shape: "hex" });
    expect(storage.getItem(LEGACY_APPEARANCE_STORAGE_KEY)).not.toBeNull();
  });

  it("renders theme and shape options with the active selections marked", () => {
    const markup = renderToStaticMarkup(
      <AppearanceMenu appearance={{ theme: "light", shape: "dot" }} onChange={vi.fn()} />,
    );

    expect(markup).toContain("深空");
    expect(markup).toContain("日间");
    expect(markup).toContain("翠绿");
    expect(markup).toContain("樱花");
    expect(markup).toContain("蜂巢");
    expect(markup).toContain("圆点");
    expect(markup).not.toContain("午夜蓝");
    expect(markup).not.toContain("暖沙");
    expect(markup.match(/class="appearance-option"/g)).toHaveLength(4);
    expect(markup.match(/class="appearance-option is-active"/g)).toHaveLength(2);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(markup).toContain('class="theme-swatch is-emerald"');
    expect(markup).toContain('class="theme-swatch is-sakura"');
    expect(markup.match(/class="shape-glyph"/g)).toHaveLength(2);
    expect(markup).not.toContain("style=");
  });
});
