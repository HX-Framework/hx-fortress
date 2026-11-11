// The two health endpoints, served alone.
//
// A fortress with Sessions off starts no gateway: there is nothing for it to
// ingest or serve. But a platform's health check may already point at the
// gateway port, because that is where the README says `/healthz` and `/readyz`
// are. Without this, switching Sessions off would make that check fail and the
// platform would restart the container for good.
//
// So the same port answers the same two paths, and nothing else. Every other
// path is 404: no route here reads or writes a session.

import type { ScopedLogger } from "../host/types";
import type { GatewayHandle } from "./server";

export interface HealthOnlyDeps {
  port: number;
  logger: ScopedLogger;
  postgresReady: () => boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startHealthOnlyServer(deps: HealthOnlyDeps): GatewayHandle {
  const server = Bun.serve({
    port: deps.port,
    fetch: (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
      if (req.method === "GET" && url.pathname === "/readyz") {
        // With no session store to wait for, ready means the database answers.
        const ready = deps.postgresReady();
        return json({ ok: ready, ready }, ready ? 200 : 503);
      }
      return json({ error: "not found" }, 404);
    },
  });
  const port = server.port ?? deps.port;
  deps.logger.info("Sessions is off: serving the health endpoints only", { port });
  return {
    port,
    stop: () => {
      void server.stop(true);
    },
  };
}
