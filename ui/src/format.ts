// Rendering numbers and instants — and the one rule that governs all of it.
//
// ABSENT IS NOT ZERO. A null count means the fortress could not answer, and
// printing 0 there says the opposite of what is true: an install whose metrics
// file has never been written would read as a fortress that has done nothing.
// Every helper here takes null and returns an em dash, so a missing answer looks
// missing on the page.

const DASH = "—";

/** A count arrives as a number or, for a bigint column, as the string the driver
 *  hands back. Both are the same fact, and a page that formatted one and printed
 *  the other raw would show two different shapes for the same kind of number. */
type Numeric = number | string | null | undefined;

function num(value: Numeric): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function int(value: Numeric): string {
  const n = num(value);
  return n === null ? DASH : n.toLocaleString("en-US");
}

export function bytes(value: Numeric): string {
  const n = num(value);
  if (n === null) return DASH;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${Math.round(n)} B`;
}

export function tokens(value: Numeric): string {
  const n = num(value);
  if (n === null) return DASH;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function usd(value: Numeric): string {
  const n = num(value);
  return n === null ? DASH : `$${n.toFixed(2)}`;
}

/** An instant, in the reader's own timezone — this console is read by the person
 *  standing next to the machine. */
export function when(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return DASH;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return DASH;
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * What a title's provenance means, said plainly.
 *
 * The NULL arm is conservative on purpose. A row with a title and no recorded
 * source may have been derived from the conversation by a build that predates
 * the column, so it is treated as derived-from-content and the chip says the
 * source is unknown rather than implying the client supplied it.
 */
export function titleSourceChip(
  titleSource: string | null,
  title: string | null,
): { label: string; derived: boolean } | null {
  if (!title) return null;
  if (titleSource === null) return { label: "source unknown", derived: true };
  if (titleSource === "fallback") return { label: "first message", derived: true };
  if (titleSource === "ai") return { label: "model summary", derived: true };
  return { label: titleSource, derived: false };
}

export function derivedFromContent(titleSource: string | null, title: string | null): boolean {
  return titleSourceChip(titleSource, title)?.derived ?? false;
}
