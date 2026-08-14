// The console's one long-lived connection, and the caps that keep it from
// becoming the way to take the console down.
//
// TRANSPORT is fetch + ReadableStream, never EventSource. EventSource cannot set
// a request header, and the console's session lives in a header by design - a
// cookie is attached by the browser to every request an attacker can cause,
// which is what makes CSRF a category. So the stream is opened with fetch,
// carrying x-fortress-ui-token like every other authenticated call, and the SSE
// framing is written by hand.
//
// CAPS are keyed per SESSION and per USER, under a small global ceiling. One
// number would not do: a global-only cap lets one person with a tab-restoring
// browser lock everybody else out, and a per-user-only cap lets a handful of
// accounts exhaust the process. A user at their own cap must never be able to
// stop another user opening their first stream, which is the acceptance.
//
// REVOCATION is not a poll. Streams register against the session table's drop
// seam, so a disable, a delete, a password change or an explicit revoke closes
// every stream that session holds immediately - and the heartbeat re-checks the
// user record as a belt, so a revocation that happened in ANOTHER process (the
// CLI writing users.json) still lands within one beat.

import { SESSION_HEADER } from "./wire";

export const EVENTS_PATH = "/ui/api/events";

/** Heartbeat cadence. Also the bound on how long a stream can outlive a
 *  revocation performed by another process. */
export const EVENTS_HEARTBEAT_MS = 15_000;

/** How long the SERVER may leave a connection idle before closing it, in
 *  seconds — Bun.serve's `idleTimeout`, whose cap is 255.
 *
 *  An SSE stream is idle BY DESIGN between heartbeats, and Bun's default is 10
 *  seconds: shorter than the 15s heartbeat above, so every live connection was
 *  killed ~12s in, before the first heartbeat could reset the clock. The client
 *  reconnected a second later and the console flashed "Reconnecting the live
 *  feed" on a 12-second loop against a completely healthy fortress — a banner
 *  that cries wolf is worse than none, because the one time the feed really is
 *  gone it reads as the usual flicker.
 *
 *  DERIVED, never a second literal: the two numbers are one decision, and a
 *  heartbeat edited without this would resurrect exactly the same bug. Two full
 *  heartbeats plus a margin, so ONE missed heartbeat does not close a stream
 *  that is otherwise healthy. */
export const EVENTS_IDLE_TIMEOUT_S = Math.min(255, Math.ceil((EVENTS_HEARTBEAT_MS * 2) / 1000) + 5);

/** The `retry:` field the server sends on open - the client's backoff FLOOR.
 *  The schedule below is the client's own; this is what a browser falls back to
 *  if the script is not the one that reconnects. */
export const EVENTS_RETRY_MS = 3_000;

/** The client's reconnect schedule, in milliseconds, with the last value
 *  repeating. Owned here rather than in the app so the server's retry floor and
 *  the client's ceiling are one decision. */
export const EVENTS_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Per SESSION. Two, so a page can hold one while a reload opens the next
 *  without either being refused. */
export const EVENTS_PER_SESSION_CAP = 2;
/** Per USER, across their sessions. */
export const EVENTS_PER_USER_CAP = 4;
/** Process-wide. Deliberately small: every stream is a held connection, a timer
 *  and a tail. */
export const EVENTS_GLOBAL_CEILING = 24;

export interface StreamEvent {
  /** Becomes the SSE `id:` field, which the client echoes as last-event-id. */
  id?: string;
  event: string;
  data: unknown;
}

/** Produces events until the signal aborts. `lastEventId` is the client's own
 *  resume point - a log offset, a sequence number - and is passed through
 *  untouched, because only the producer knows what it means. */
export interface EventProducer {
  start(
    sink: (event: StreamEvent) => void,
    signal: AbortSignal,
    lastEventId: string | null,
  ): void | Promise<void>;
}

export type StreamCloseReason =
  | "client"
  | "revoked"
  | "disabled"
  | "shutdown"
  | "producer-ended";

export interface StreamHandle {
  id: string;
  sessionId: string;
  userLogin: string;
  close(reason: StreamCloseReason): void;
}

export type OpenStreamVerdict =
  | { ok: true; response: Response; handle: StreamHandle }
  | { ok: false; status: 429; reason: string; retryAfterMs: number };

export interface OpenStreamArgs {
  sessionId: string;
  userLogin: string;
  lastEventId?: string | null;
  producer: EventProducer;
  /** Re-checked on every heartbeat. False closes the stream. This is the belt
   *  for revocations performed by another process. */
  stillValid?: () => boolean | Promise<boolean>;
  heartbeatMs?: number;
  now?: () => number;
}

interface LiveStream {
  handle: StreamHandle;
  controller: AbortController;
}

/**
 * Every open stream, and the only thing that may open one.
 *
 * Held on the runtime rather than per-request, because the caps are process-wide
 * facts and revocation has to reach a stream opened by a request that finished
 * long ago.
 */
export class EventStreamRegistry {
  private readonly streams = new Map<string, LiveStream>();
  private counter = 0;

  get size(): number {
    return this.streams.size;
  }

  countForSession(sessionId: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.handle.sessionId === sessionId) n += 1;
    return n;
  }

  countForUser(login: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.handle.userLogin === login) n += 1;
    return n;
  }

  /** Attach to a session table (or anything with the same seam) so a dropped
   *  session takes its streams with it. Returns the detach function. */
  attachRevocation(onDrop: (listener: (session: { id: string }) => void) => () => void): () => void {
    return onDrop((session) => {
      this.closeSession(session.id, "revoked");
    });
  }

  open(args: OpenStreamArgs): OpenStreamVerdict {
    if (this.countForSession(args.sessionId) >= EVENTS_PER_SESSION_CAP) {
      return {
        ok: false,
        status: 429,
        reason: "this tab already has the live connections it is allowed - close one and retry",
        retryAfterMs: EVENTS_RETRY_MS,
      };
    }
    if (this.countForUser(args.userLogin) >= EVENTS_PER_USER_CAP) {
      return {
        ok: false,
        status: 429,
        reason: "this account already has the live connections it is allowed - close a tab and retry",
        retryAfterMs: EVENTS_RETRY_MS,
      };
    }
    if (this.streams.size >= EVENTS_GLOBAL_CEILING) {
      return {
        ok: false,
        status: 429,
        reason: "this console is serving all the live connections it can - try again shortly",
        retryAfterMs: EVENTS_RETRY_MS,
      };
    }

    const id = `es-${(this.counter += 1).toString(36)}`;
    const controller = new AbortController();
    const heartbeatMs = args.heartbeatMs ?? EVENTS_HEARTBEAT_MS;
    const encoder = new TextEncoder();
    // Captured by the closures below rather than aliased through `this`: the
    // ReadableStream callbacks are plain methods on an object literal, so inside
    // them `this` is the stream, not this class.
    const streams = this.streams;
    let closed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    /** Set once the stream body starts. Until then, closing is just dropping the
     *  registration - a stream nobody has begun reading has nothing to say
     *  goodbye on. `start` runs synchronously inside the constructor below, so
     *  the handle has to exist before it. */
    let finish: ((reason: StreamCloseReason) => void) | null = null;
    const teardown = (): void => {
      closed = true;
      if (timer) clearInterval(timer);
      streams.delete(id);
      controller.abort();
    };
    const handle: StreamHandle = {
      id,
      sessionId: args.sessionId,
      userLogin: args.userLogin,
      close: (reason) => (finish ? finish(reason) : teardown()),
    };
    this.streams.set(id, { handle, controller });

    const stream = new ReadableStream<Uint8Array>({
      start(sink) {
        const write = (text: string): void => {
          if (closed) return;
          try {
            sink.enqueue(encoder.encode(text));
          } catch {
            // The peer went away between the check and the write.
            end("client");
          }
        };
        const send = (event: StreamEvent): void => {
          const lines = [
            event.id === undefined ? null : `id: ${event.id}`,
            `event: ${event.event}`,
            `data: ${JSON.stringify(event.data)}`,
            "",
            "",
          ].filter((l) => l !== null);
          write(lines.join("\n"));
        };
        const end = (reason: StreamCloseReason): void => {
          if (closed) return;
          teardown();
          try {
            if (reason !== "client") {
              // Say WHY before hanging up. A client that reconnects blindly after
              // a revocation would spend its whole backoff schedule discovering
              // it is signed out.
              sink.enqueue(encoder.encode(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`));
            }
            sink.close();
          } catch {
            // Already closed by the peer.
          }
        };

        finish = end;
        // The retry floor first, so a client that loses the connection before it
        // reads anything still knows how long to wait.
        write(`retry: ${EVENTS_RETRY_MS}\n\n`);
        send({ event: "open", data: { streamId: id, heartbeatMs } });

        timer = setInterval(() => {
          void (async () => {
            const valid = args.stillValid ? await args.stillValid() : true;
            if (!valid) {
              end("disabled");
              return;
            }
            // A comment frame: it keeps proxies from idling the connection out
            // and costs the client nothing to parse.
            write(`: heartbeat ${(args.now?.() ?? Date.now()).toString()}\n\n`);
          })().catch(() => {
            // `stillValid` reads the user store, which THROWS on any unreadable
            // file (EACCES, EIO, EMFILE, a torn JSON). Unhandled here that
            // rejection exits the whole console process - the one process whose
            // job is to say what is broken on a broken fortress, and it would
            // die again on every restart's next stream. The fail direction is
            // chosen explicitly: a session we cannot re-affirm is hung up.
            end("disabled");
          });
        }, heartbeatMs);
        (timer as { unref?: () => void }).unref?.();

        void Promise.resolve(args.producer.start(send, controller.signal, args.lastEventId ?? null))
          .then(() => end("producer-ended"))
          .catch(() => end("producer-ended"));
      },
      cancel() {
        // The reader hung up. No goodbye frame is possible and none is wanted.
        if (!closed) teardown();
      },
    });

    return {
      ok: true,
      handle,
      response: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          // Set here rather than by the response finisher: a stream is already
          // flowing when the finisher would run. The two that belong on a live
          // body are carried anyway - a sniffed event stream is a stream a
          // browser may decide to execute, and a referrer is a leak whatever
          // the content type.
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          // Platform edges buffer text/event-stream by default, which turns a
          // live stream into a page that arrives at the end.
          "x-accel-buffering": "no",
          connection: "keep-alive",
        },
      }),
    };
  }

  closeSession(sessionId: string, reason: StreamCloseReason = "revoked"): number {
    let closed = 0;
    for (const stream of [...this.streams.values()]) {
      if (stream.handle.sessionId === sessionId) {
        stream.handle.close(reason);
        closed += 1;
      }
    }
    return closed;
  }

  closeUser(login: string, reason: StreamCloseReason = "revoked"): number {
    let closed = 0;
    for (const stream of [...this.streams.values()]) {
      if (stream.handle.userLogin === login) {
        stream.handle.close(reason);
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(reason: StreamCloseReason = "shutdown"): number {
    let closed = 0;
    for (const stream of [...this.streams.values()]) {
      stream.handle.close(reason);
      closed += 1;
    }
    return closed;
  }
}

/**
 * The client contract, stated once.
 *
 * The app implements it; this is where the decisions live, so the two cannot
 * drift into different ideas of how the connection behaves.
 */
export const EVENT_STREAM_CLIENT_CONTRACT = {
  path: EVENTS_PATH,
  /** fetch + ReadableStream. EventSource cannot set this header, and cookies are
   *  banned as a session medium. */
  header: SESSION_HEADER,
  /** Held per tab, so a second tab signs in again and an XSS reads one tab. */
  tokenMedium: "sessionStorage",
  /** Sent as the `last-event-id` header on reconnect. */
  resumeHeader: "last-event-id",
  backoffMs: EVENTS_BACKOFF_MS,
  /** The client closes when the tab is hidden. A background tab holding a stream
   *  is a cap slot spent on a page nobody is reading. */
  closeOn: "visibilitychange",
} as const;
