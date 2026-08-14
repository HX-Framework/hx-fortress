/**
 * Loopback hub for CI — simulates the Let.ai cloud hub over a real local WebSocket.
 * Responds to enroll/hello/heartbeat automatically; tests can inject frames and
 * inspect everything received. T14/T16 import this to drive end-to-end tests
 * without a live cloud connection.
 */

import type { ServerWebSocket } from "bun";
import { createServer } from "node:net";
import { decodeFrame, encodeFrame } from "../src/protocol";
import type {
  FortressQueryPayload,
  FortressQueryResultPayload,
  FortressToHubFrame,
  HubToFortressFrame,
} from "../src/protocol";
import { SUPPORTED_PROTOCOL_VERSION } from "../src/cloud/connection";

/** What a hub does with a bounded question. Returning `null` is the OLD-HUB
 *  case — no answer at all, which is exactly what a hub that never learned the
 *  frame does, and the case a timeout has to terminate. */
export type QueryAnswer =
  | { result: FortressQueryResultPayload }
  | { error: string }
  | null;

export interface FakeHubOptions {
  /** Override the org id sent in enrolled/welcome (default "test-org"). */
  orgId?: string;
  /** Override the fortress id sent in enrolled (default "test-fortress"). */
  fortressId?: string;
  /** Override the credential sent in enrolled (default "test-credential"). */
  credential?: string;
  /** Override the protocol version reported in enrolled/welcome (default SUPPORTED_PROTOCOL_VERSION). */
  protocolVersion?: number;
  /**
   * If set, the hub sends a `fatal` frame immediately after receiving hello/enroll
   * instead of the normal enrolled/welcome response.
   */
  rejectWith?: string;
  /** Omitted = an old hub: fortressQuery is ignored, silently. */
  answerQuery?: (query: FortressQueryPayload, id: string) => QueryAnswer;
}

export class FakeHub {
  readonly url: string;
  private readonly server: Bun.Server<undefined>;
  private socket: ServerWebSocket<undefined> | null = null;
  private _received: Array<FortressToHubFrame> = [];
  private readonly opts: Required<Omit<FakeHubOptions, "rejectWith" | "answerQuery">> &
    Pick<FakeHubOptions, "rejectWith" | "answerQuery">;

  static async create(options: FakeHubOptions = {}): Promise<FakeHub> {
    const port = await reservePort();
    const opts = {
      orgId: options.orgId ?? "test-org",
      fortressId: options.fortressId ?? "test-fortress",
      credential: options.credential ?? "test-credential",
      protocolVersion: options.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION,
      rejectWith: options.rejectWith,
      answerQuery: options.answerQuery,
    };
    const hub = new FakeHub(
      Bun.serve<undefined>({
        port,
        hostname: "127.0.0.1",
        fetch: (req, server) => {
          if (server.upgrade(req)) return undefined;
          return new Response("not found", { status: 404 });
        },
        websocket: {
          open: (ws) => {
            hub.socket = ws;
          },
          message: (ws, data) => {
            const raw = typeof data === "string" ? data : data.toString();
            let frame: FortressToHubFrame;
            try {
              frame = decodeFrame<FortressToHubFrame>(raw);
            } catch {
              return;
            }
            hub._received.push(frame);
            hub.autoRespond(ws, frame);
          },
          close: () => {
            hub.socket = null;
          },
        },
      }),
      opts,
    );
    return hub;
  }

  private constructor(
    server: Bun.Server<undefined>,
    options: Required<Omit<FakeHubOptions, "rejectWith" | "answerQuery">> &
      Pick<FakeHubOptions, "rejectWith" | "answerQuery">,
  ) {
    this.server = server;
    this.opts = options;
    this.url = `ws://127.0.0.1:${this.server.port}`;
  }

  /** All frames received from the Fortress client, in arrival order. */
  received(): ReadonlyArray<FortressToHubFrame> {
    return [...this._received];
  }

  /** Send a frame down to the connected Fortress client. */
  send(frame: HubToFortressFrame): void {
    this.socket?.send(encodeFrame(frame));
  }

  /** Drop the current connection without a fatal frame, triggering client reconnect. */
  dropConnection(): void {
    this.socket?.close(1001, "test-drop");
  }

  /** Stop the hub server, immediately closing any open connections.
   *
   *  BOUNDED: a socket this hub closed from its own side leaves the forced stop
   *  waiting on a peer that may never answer, and a rig that can hang is a rig
   *  that hangs the whole suite. Each hub reserves a fresh port, so giving up on
   *  the wait costs nothing. */
  async stop(): Promise<void> {
    await Promise.race([this.server.stop(true), Bun.sleep(250)]);
  }

  private autoRespond(
    ws: ServerWebSocket<undefined>,
    frame: FortressToHubFrame,
  ): void {
    const { orgId, fortressId, credential, protocolVersion, rejectWith } = this.opts;

    if (frame.t === "fortressQuery") {
      const answer = this.opts.answerQuery?.(frame.query, frame.id) ?? null;
      if (!answer) return; // an old hub answers nothing at all
      ws.send(
        encodeFrame(
          "error" in answer
            ? { t: "fortressQueryError", id: frame.id, error: answer.error }
            : { t: "fortressQueryResult", id: frame.id, result: answer.result },
        ),
      );
      return;
    }

    if (frame.t === "enroll") {
      if (rejectWith) {
        ws.send(encodeFrame({ t: "fatal", reason: rejectWith }));
      } else {
        ws.send(encodeFrame({ t: "enrolled", orgId, fortressId, credential, protocolVersion }));
      }
    } else if (frame.t === "hello") {
      if (rejectWith) {
        ws.send(encodeFrame({ t: "fatal", reason: rejectWith }));
      } else {
        ws.send(encodeFrame({ t: "welcome", orgId, protocolVersion }));
      }
    } else if (frame.t === "heartbeat") {
      ws.send(encodeFrame({ t: "heartbeatAck" }));
    }
  }
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
