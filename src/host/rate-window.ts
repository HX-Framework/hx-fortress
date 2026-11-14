// At most N starts in any minute.
//
// The limits on what the control plane can make this host do are stated that
// way: so many asks, so many release downloads, so many different refusals
// written to the audit trail, "in any minute". This file is what makes the
// statement exact.
//
// It keeps the time of every start that is still inside the window, and allows
// a new one only while fewer than N are inside. Two cheaper ways to count do not
// hold the bound:
//
//   • A bucket of N that refills evenly lets N starts through at once and N more
//     over the following minute: 2N in one minute.
//   • A counter that is reset each minute lets N through just before a reset and
//     N just after it: 2N in a few seconds.
//
// The cost is one number for each start inside the window, so at most N
// numbers. Only a start that was allowed is kept: a refused one costs nothing.

export class RateWindow {
  /** When each start happened, oldest first. Those before `head` have left the
   *  window and wait to be dropped. */
  private starts: number[] = [];
  private head = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Starts inside the window that ends at `now`. */
  count(now: number): number {
    this.forget(now);
    return this.starts.length - this.head;
  }

  /** Take one start at `now`. False, and nothing is taken, when `max` starts
   *  are already inside the window. */
  take(now: number): boolean {
    this.forget(now);
    if (!(this.starts.length - this.head < this.max)) return false;
    this.starts.push(now);
    return true;
  }

  private forget(now: number): void {
    // A clock that was set back would leave starts in the future, and they would
    // hold their places until the clock passed them again: after a step of a
    // day, for a day. A start is never later than now, so such a start is moved
    // to now and leaves the window a full window later.
    // `i` counts over this object's own list of numbers.
    /* eslint-disable security/detect-object-injection */
    for (let i = this.starts.length - 1; i >= this.head && (this.starts[i] as number) > now; i -= 1) {
      this.starts[i] = now;
    }
    /* eslint-enable security/detect-object-injection */
    while (
      this.head < this.starts.length &&
      now - (this.starts[this.head] as number) >= this.windowMs
    ) {
      this.head += 1;
    }
    // Dropped in batches, so taking a start does not copy the list each time.
    if (this.head >= 256 && this.head * 2 >= this.starts.length) {
      this.starts = this.starts.slice(this.head);
      this.head = 0;
    }
  }
}
