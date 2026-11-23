import { useId, useMemo, useState } from "react";
import type { RefObject } from "react";
import { applySuggestion, suggest } from "../query";
import type { Vocabulary } from "../query";

interface QueryInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no suggestion chosen runs the search. */
  onEnter: () => void;
  /** Escape with no suggestions open clears the search. */
  onClear: () => void;
  vocabulary: Vocabulary;
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  className?: string;
}

/**
 * The Trill search box with autocomplete: keywords, levels, services, envs,
 * field keys, and common field values. It opens while typing (or with
 * Ctrl+Space / ArrowDown). Arrow keys move through suggestions,
 * Tab accepts, Enter accepts only once one is chosen (otherwise it searches),
 * and Escape closes the menu, or clears the search when it is already closed.
 */
export default function QueryInput(props: QueryInputProps) {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const suggestions = useMemo(
    () => (open ? suggest(props.value, caret, props.vocabulary) : null),
    [open, props.value, caret, props.vocabulary],
  );

  const items = suggestions?.items ?? [];
  const highlighted = active >= 0 && active < items.length ? active : -1;

  const syncCaret = (): void => {
    setCaret(props.inputRef.current?.selectionStart ?? props.value.length);
  };

  const accept = (index: number): void => {
    const item = items[index];

    if (!suggestions || !item) return;
    const next = applySuggestion(props.value, suggestions, item);

    props.onChange(next.text);
    setCaret(next.caret);
    setActive(-1);
    setOpen(item.continues);
    requestAnimationFrame(() => {
      props.inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={props.inputRef}
        value={props.value}
        role="combobox"
        aria-label="Search logs"
        aria-autocomplete="list"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
        onChange={(e) => {
          props.onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={syncCaret}
        onBlur={() => setOpen(false)}
        onClick={syncCaret}
        onKeyUp={(e) => {
          if (
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "Home" ||
            e.key === "End"
          ) {
            syncCaret();
          }
        }}
        onKeyDown={(e) => {
          // The menu opens while typing, or on demand with Ctrl+Space or
          // ArrowDown, so focusing the box never covers the log table.
          if (!open && (e.key === "ArrowDown" || (e.key === " " && e.ctrlKey))) {
            e.preventDefault();
            syncCaret();
            setOpen(true);

            return;
          }

          if (items.length > 0 && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((highlighted + 1) % items.length);

            return;
          }

          if (items.length > 0 && e.key === "ArrowUp") {
            e.preventDefault();
            setActive(highlighted <= 0 ? items.length - 1 : highlighted - 1);

            return;
          }

          if (items.length > 0 && e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            accept(Math.max(highlighted, 0));

            return;
          }

          if (e.key === "Escape" && items.length > 0) {
            e.preventDefault();
            setOpen(false);

            return;
          }

          if (e.key === "Escape" && props.value !== "") {
            e.preventDefault();
            props.onClear();

            return;
          }

          if (e.key === "Enter") {
            if (highlighted >= 0) {
              e.preventDefault();
              accept(highlighted);

              return;
            }

            setOpen(false);
            props.onEnter();
          }
        }}
        spellCheck={false}
        placeholder={props.placeholder}
        className={props.className}
      />
      {items.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute left-0 top-full z-30 mt-1.5 max-h-72 w-[min(32rem,90vw)] overflow-y-auto rounded-[5px] border border-white/[0.1] bg-ink-900 py-1 shadow-xl"
        >
          {items.map((item, index) => (
            <div
              key={`${item.insert}-${index}`}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === highlighted}
              // mousedown keeps focus in the input; click would blur it first.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(index);
              }}
              onMouseEnter={() => setActive(index)}
              className={
                "flex cursor-pointer items-baseline justify-between gap-3 px-2.5 py-1 font-mono text-xs " +
                (index === highlighted ? "bg-gold/10 text-gold" : "text-mist")
              }
            >
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 text-[10px] text-mist-faint">{item.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
