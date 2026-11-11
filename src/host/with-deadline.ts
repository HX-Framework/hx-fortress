/** Reject if `p` doesn't settle within `ms`. The underlying work isn't
 *  cancellable, so a late settle is ignored — but BOTH of its outcomes are
 *  observed here, so a loser can never surface as an unhandled rejection (Bun
 *  exits the process on one). Shared by the MCP dispatch ceiling and the vault
 *  RPC PG-phase races. */
export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  options: {
    /** The error to reject with, for a caller that tells a deadline from the
     *  work's own failure by its class. Defaults to `new Error(message)`. */
    error?: () => Error;
    /** True when the timer must not keep the process alive on its own. */
    unref?: boolean;
  } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(options.error?.() ?? new Error(message)), ms);
    if (options.unref) (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
