export type ThemeName = "dark" | "light" | "emerald" | "sakura";
export type ShapeName = "hex" | "dot";

export interface Appearance {
  theme: ThemeName;
  shape: ShapeName;
}

export const APPEARANCE_STORAGE_KEY = "session-atlas.appearance.v2";
export const LEGACY_APPEARANCE_STORAGE_KEY = "session-atlas.appearance.v1";

export const DEFAULT_APPEARANCE: Appearance = { theme: "dark", shape: "hex" };

const THEME_NAMES: readonly ThemeName[] = ["dark", "light", "emerald", "sakura"];
const SHAPE_NAMES: readonly ShapeName[] = ["hex", "dot"];

// Keep in sync with the normalize map in public/appearance-bootstrap.js.
const RETIRED_THEME_MAP: Record<string, ThemeName> = {
  midnight: "dark",
  sand: "light",
};

const THEME_COLORS: Record<ThemeName, string> = {
  dark: "#0f131a",
  light: "#e8ecf2",
  emerald: "#0a1410",
  sakura: "#f4edef",
};

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

export function isShapeName(value: unknown): value is ShapeName {
  return typeof value === "string" && (SHAPE_NAMES as readonly string[]).includes(value);
}

function resolveTheme(value: unknown): ThemeName {
  if (isThemeName(value)) {
    return value;
  }
  if (typeof value === "string" && value in RETIRED_THEME_MAP) {
    return RETIRED_THEME_MAP[value]!;
  }
  return DEFAULT_APPEARANCE.theme;
}

function isRetiredThemeName(value: unknown): boolean {
  return typeof value === "string" && value in RETIRED_THEME_MAP;
}

export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) {
    return DEFAULT_APPEARANCE;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_APPEARANCE;
    }
    const candidate = parsed as Record<string, unknown>;
    return {
      theme: resolveTheme(candidate.theme),
      shape: isShapeName(candidate.shape) ? candidate.shape : DEFAULT_APPEARANCE.shape,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function readAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (stored !== null) {
      const appearance = parseAppearance(stored);
      try {
        const rawTheme = (JSON.parse(stored) as Record<string, unknown> | null)?.theme;
        // Rewrite retired theme names (midnight/sand) so the next paint reads the new value directly.
        if (isRetiredThemeName(rawTheme)) {
          persistAppearance(appearance);
        }
      } catch {
        // Corrupt JSON already fell back to defaults in parseAppearance.
      }
      return appearance;
    }
    // Migrate the v1 entry: resolve the theme (retired names included), drop the removed shape variant.
    const legacy = window.localStorage.getItem(LEGACY_APPEARANCE_STORAGE_KEY);
    if (legacy === null) {
      return DEFAULT_APPEARANCE;
    }
    const migrated = parseAppearance(legacy);
    persistAppearance(migrated);
    window.localStorage.removeItem(LEGACY_APPEARANCE_STORAGE_KEY);
    return migrated;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function persistAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // A denied localStorage write must not block theme switching.
  }
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = appearance.theme;
  root.dataset.shape = appearance.shape;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[appearance.theme]);
}
