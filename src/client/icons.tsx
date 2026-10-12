import type { SVGProps } from "react";

export type IconName =
  | "alert"
  | "atlas"
  | "archive"
  | "arrow"
  | "back"
  | "branch"
  | "check"
  | "chevron"
  | "clock"
  | "close"
  | "copy"
  | "failure"
  | "focus"
  | "layout"
  | "lightning"
  | "message"
  | "palette"
  | "pin"
  | "plus"
  | "refresh"
  | "search"
  | "send"
  | "stop";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.5,
  };

  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props} {...common}>
      {name === "alert" ? (
        <>
          <path d="M10.2 3.9 2.8 17.1A2 2 0 0 0 4.55 20h14.9a2 2 0 0 0 1.75-2.9L13.8 3.9a2.06 2.06 0 0 0-3.6 0Z" />
          <path d="M12 8.2v5.5M12 17.2h.01" />
        </>
      ) : null}
      {name === "atlas" ? (
        <>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 1.75v5M12 17.25v5M1.75 12h5M17.25 12h5" />
          <path d="M4.25 17.7c2.85 1.45 7.15.45 10.75-2.55 3.6-3 5.15-6.95 4.1-9.9" />
          <path d="M4.9 5.2c1.05-.65 2.4-1.05 3.95-1.15" />
          <path d="m12 7.8 1.15 3.05L16.2 12l-3.05 1.15L12 16.2l-1.15-3.05L7.8 12l3.05-1.15L12 7.8Z" />
          <circle cx="19.1" cy="5.25" r="1.35" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {name === "archive" ? (
        <>
          <path d="M4 8.1h16v11.2H4zM3 4.7h18v3.4H3z" />
          <path d="M9.2 12h5.6" />
        </>
      ) : null}
      {name === "arrow" ? <path d="M5 12h13M13.5 6.5 19 12l-5.5 5.5" /> : null}
      {name === "back" ? <path d="m14.5 5.5-6.5 6.5 6.5 6.5" /> : null}
      {name === "branch" ? (
        <>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="6" cy="19" r="2" />
          <path d="M6 7v10M8 15h2.5A7.5 7.5 0 0 0 18 8" />
        </>
      ) : null}
      {name === "check" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.2 2.6 2.7 5.7-6" />
        </>
      ) : null}
      {name === "chevron" ? <path d="m8 9 4 4 4-4" /> : null}
      {name === "clock" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.1 1.8" />
        </>
      ) : null}
      {name === "close" ? <path d="m6 6 12 12M18 6 6 18" /> : null}
      {name === "copy" ? (
        <>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </>
      ) : null}
      {name === "failure" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </>
      ) : null}
      {name === "focus" ? (
        <>
          <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : null}
      {name === "lightning" ? <path d="M13.6 2.8 5.4 13h6.1l-1 8.2L18.6 11h-6.1l1.1-8.2Z" /> : null}
      {name === "layout" ? (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 8.5h17M9.5 8.5v11" />
        </>
      ) : null}
      {name === "message" ? (
        <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.8 8.8 0 0 1-3.2-.65L4 20l1.4-4.1A7.4 7.4 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" />
      ) : null}
      {name === "pin" ? (
        <>
          <path d="m8 3 8 8M14.8 2.8l6.4 6.4-3 1.1-4.1 4.1.1 3.1-1.1 1.1-7.7-7.7 1.1-1.1 3.1.1 4.1-4.1 1.1-3Z" />
          <path d="m9.4 14.6-6.1 6.1" />
        </>
      ) : null}
      {name === "plus" ? <path d="M12 5v14M5 12h14" /> : null}
      {name === "refresh" ? (
        <>
          <path d="M20 7v5h-5" />
          <path d="M18.4 16.6A8 8 0 1 1 19.9 12L15 12" />
        </>
      ) : null}
      {name === "search" ? (
        <>
          <circle cx="10.8" cy="10.8" r="6.8" />
          <path d="m16 16 4.4 4.4" />
        </>
      ) : null}
      {name === "send" ? <path d="m4 4 16 8-16 8 3-8-3-8Zm3 8h13" /> : null}
      {name === "palette" ? (
        <>
          <path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.1a2.4 2.4 0 0 0 1.7-4.1l-.5-.5a2 2 0 0 1 1.4-3.4h2.2a2.6 2.6 0 0 0 2.6-2.6C20.5 6.6 16.7 3.5 12 3.5Z" />
          <circle cx="7.6" cy="10.2" r="1.15" fill="currentColor" stroke="none" />
          <circle cx="11" cy="7.4" r="1.15" fill="currentColor" stroke="none" />
          <circle cx="14.9" cy="7.9" r="1.15" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {name === "stop" ? <rect x="5" y="5" width="14" height="14" rx="1.5" /> : null}
    </svg>
  );
}
