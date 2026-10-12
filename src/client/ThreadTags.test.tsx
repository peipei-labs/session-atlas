import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThreadTagChips, ThreadTagFilter, ThreadTags } from "./ThreadTags";

Object.assign(globalThis, { React });
const threadId = "01234567-89ab-cdef-8123-456789abcdef";
type Element = React.ReactElement<{ children?: React.ReactNode; type?: string; value?: string; "aria-label"?: string;
  onClick?: () => void; onChange?: (event: { currentTarget: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void }>;
const elements = (node: React.ReactNode): Element[] => React.Children.toArray(node).flatMap((child) =>
  React.isValidElement(child) ? [child as Element, ...elements((child as Element).props.children)] : []);

function editor(initial: Partial<React.ComponentProps<typeof ThreadTags>> = {}) {
  const slots: unknown[] = [];
  let props: React.ComponentProps<typeof ThreadTags> = { threadId, tags: ["React"], onUpdateTags: vi.fn(async () => true), ...initial };
  const draw = (changes: Partial<typeof props> = {}) => {
    props = { ...props, ...changes };
    let cursor = 0;
    const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = {
      useState: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
        return [slots[slot], (next: unknown) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
      },
      useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
    };
    try { return ThreadTags(props); } finally { internals.H = previous; }
  };
  const toggle = elements(draw()).find((element) => element.props.children === "编辑标签" || element.props.children === "添加标签");
  toggle?.props.onClick?.();
  return {
    draw, onUpdateTags: props.onUpdateTags!,
    input: (value: string) => elements(draw()).find((element) => element.type === "input")!.props.onChange!({ currentTarget: { value } }),
    submit: () => elements(draw()).find((element) => element.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() }),
    value: () => elements(draw()).find((element) => element.type === "input")?.props.value,
  };
}

describe("thread tag controls", () => {
  it("renders only two compact labels plus overflow while retaining full accessible labels", () => {
    const markup = renderToStaticMarkup(<ThreadTagChips tags={["React", "TypeScript", "排障", "react"]} compact />);
    expect(markup).toContain("标签：React、TypeScript、排障");
    expect(markup).toContain(">+1</span>");
    expect(markup).not.toContain(">排障</span>");
    expect(renderToStaticMarkup(<ThreadTagChips />)).toBe("");
  });

  it("keeps a removed selected tag visible with zero count and an available clear action", () => {
    const onClear = vi.fn(), onToggle = vi.fn();
    const node = ThreadTagFilter({ tags: [], selected: ["React"], onClear, onToggle });
    const markup = renderToStaticMarkup(node);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("<em>0</em>");
    expect(markup).toContain("同时包含所选标签");
    elements(node).find((element) => element.props.children === "清除标签筛选")!.props.onClick!();
    expect(onClear).toHaveBeenCalledOnce();
    expect(ThreadTagFilter({ tags: [], selected: [], onClear, onToggle })).toBeNull();
  });

  it("only submits an additive patch and preserves drafts across refreshes and failed saves", async () => {
    const onUpdateTags = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const fixture = editor({ onUpdateTags });
    fixture.input(" Ｐｙｔｈｏｎ ");
    fixture.draw({ tags: ["React", "用户手动标签"] });
    expect(fixture.value()).toBe(" Ｐｙｔｈｏｎ ");
    fixture.submit(); await Promise.resolve();
    expect(onUpdateTags).toHaveBeenLastCalledWith(threadId, { add: ["Python"] });
    expect(fixture.value()).toBe(" Ｐｙｔｈｏｎ ");
    fixture.submit(); await Promise.resolve();
    expect(fixture.value()).toBe("");
    expect(onUpdateTags).toHaveBeenCalledTimes(2);
  });

  it("removes only the clicked tag and ignores repeated actions while its patch is pending", async () => {
    let finish!: (result: boolean) => void;
    const onUpdateTags = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const fixture = editor({ tags: ["React", "人工标签"], onUpdateTags });
    const remove = elements(fixture.draw()).find((element) => element.props["aria-label"] === "移除标签 React")!;
    remove.props.onClick!(); remove.props.onClick!();
    expect(onUpdateTags).toHaveBeenCalledExactlyOnceWith(threadId, { remove: ["React"] });
    finish(true); await Promise.resolve();
  });

  it("rejects duplicate and malformed tags locally while allowing Unicode and technical names", async () => {
    const fixture = editor();
    for (const invalid of [" Ｒｅａｃｔ ", "a\u200bb", "x".repeat(41)]) {
      fixture.input(invalid); fixture.submit();
    }
    expect(fixture.onUpdateTags).not.toHaveBeenCalled();
    fixture.input("C++"); fixture.submit(); await Promise.resolve();
    expect(fixture.onUpdateTags).toHaveBeenCalledWith(threadId, { add: ["C++"] });
  });

  it("does not expose a write control without an exact thread UUID", () => {
    expect(renderToStaticMarkup(<ThreadTags threadId="iterm:shell" tags={["React"]} onUpdateTags={vi.fn()} />)).toBe("");
    expect(renderToStaticMarkup(<ThreadTags threadId={threadId} tags={["React"]} />)).not.toContain("button");
  });
});
