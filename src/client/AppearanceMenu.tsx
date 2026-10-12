import type { Appearance, ShapeName, ThemeName } from "./appearance";

interface AppearanceMenuProps {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
}

const THEME_OPTIONS: { name: ThemeName; label: string }[] = [
  { name: "dark", label: "深空" },
  { name: "light", label: "日间" },
  { name: "emerald", label: "翠绿" },
  { name: "sakura", label: "樱花" },
];

const SHAPE_OPTIONS: { name: ShapeName; label: string }[] = [
  { name: "hex", label: "蜂巢" },
  { name: "dot", label: "圆点" },
];

function ShapeGlyph({ shape }: { shape: ShapeName }) {
  return (
    <span className="shape-glyph" aria-hidden="true">
      <svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        {shape === "hex" ? (
          <path d="M7.2 4.2h9.6l4.8 7.8-4.8 7.8H7.2L2.4 12Z" strokeLinejoin="round" />
        ) : (
          <circle cx="12" cy="12" r="7.6" />
        )}
      </svg>
    </span>
  );
}

export function AppearanceMenu({ appearance, onChange }: AppearanceMenuProps) {
  return (
    <div className="appearance-menu" role="menu" aria-label="外观设置">
      <div className="appearance-group">
        <span>主题</span>
        <div className="appearance-options">
          {THEME_OPTIONS.map((option) => (
            <button
              aria-pressed={appearance.theme === option.name}
              className={`appearance-option${appearance.theme === option.name ? " is-active" : ""}`}
              key={option.name}
              onClick={() => onChange({ ...appearance, theme: option.name })}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`theme-swatch is-${option.name}`}
              />
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="appearance-group">
        <span>图案</span>
        <div className="appearance-options">
          {SHAPE_OPTIONS.map((option) => (
            <button
              aria-pressed={appearance.shape === option.name}
              className={`appearance-option${appearance.shape === option.name ? " is-active" : ""}`}
              key={option.name}
              onClick={() => onChange({ ...appearance, shape: option.name })}
              type="button"
            >
              <ShapeGlyph shape={option.name} />
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
