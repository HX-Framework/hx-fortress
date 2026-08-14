/** Reject if `p` doesn't settle within `ms`. The underlying work isn't
 *  cancellable, so a late settle is ignored — but BOTH of its outcomes are
 *  observed here, so a loser can never surface as an unhandled rejection (Bun
 *  exits the process on one). Shared by the MCP dispatch ceiling and the vault
 *  RPC PG-phase races. */
export function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
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
