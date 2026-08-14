// Data paths in and out of this host.
//
// The panel used to be called "egress" and listed the flows somebody remembered.
// Both were wrong. It is not egress-only - the roster arrives, the relay carries
// questions inward - and a hand-kept list is a list that goes stale the release
// after it is written, silently, because nothing fails when a flow is missing
// from a page.
//
// So every row here is COMPUTED from effective configuration, and the two rows
// that enumerate call sites are diffed against the code that serves them: the
// relay row against the vault RPC switch, the outbound rows against the fetch
// call sites. A flow that exists and is not listed fails a test rather than
// misleading a reader.
//
// The rows say uncomfortable things where they are true. The console process
// holds a bucket-write-capable key, because the fortress has ONE credential for
// reads and writes; the metadata database carries transcript text and
// embeddings, whatever the console itself is allowed to read; and the relay row
// does not claim "never transcript objects", because two of the methods it
// serves stream exactly that.

import { LOOPBACK_BIND } from "./bind";
import type { UiConfig } from "./config";
import { remoteKeySourceLine } from "./remote-key";

export const EGRESS_TITLE = "Data paths in and out of this host";

export type FlowDirection = "in" | "out" | "both";

export interface DataPathRow {
  id: string;
  name: string;
  direction: FlowDirection;
  /** Where the bytes go, or come from, as resolved - never as configured-in-theory. */
  peer: string;
  /** What actually travels. Stated at its true sensitivity. */
  carries: string;
  /** What authorizes it. */
  gate: string;
  /** Extra sentences the row must not omit. */
  notes?: string[];
}

/** One entry per method the vault RPC dispatcher SERVES. The set is diffed
 *  against the dispatcher's switch, so a method added there without a row here
 *  fails rather than shipping an inventory that omits a data path. */
export interface RelayMethodRow {
  method: string;
  direction: FlowDirection;
  carries: "session bytes" | "session metadata" | "inbound writes" | "control";
  gate: string;
}

export const RELAY_METHODS: readonly RelayMethodRow[] = [
  {
    method: "readChunkText",
    direction: "out",
    carries: "session bytes",
    gate: "a hub-minted capability grant for this session, verified against the org key",
  },
  {
    method: "readCanonical",
    direction: "out",
    carries: "session bytes",
    gate: "a hub-minted capability grant for this session (whole object or a byte range)",
  },
  {
    method: "signCanonicalDownload",
    direction: "out",
    carries: "session bytes",
    gate: "a hub-minted capability grant; the signed URL then bypasses this host entirely",
  },
  {
    method: "readArtifactText",
    direction: "out",
    carries: "session bytes",
    gate: "a hub-minted capability grant, restricted to the allowlisted sidecar names",
  },
  {
    method: "listSessionMetadata",
    direction: "out",
    carries: "session metadata",
    gate: "a hub-minted grant scoped to one user id",
  },
  {
    method: "listSessions",
    direction: "out",
    carries: "session metadata",
    gate: "a hub-minted grant scoped to one user id, read from this host's Postgres",
  },
  {
    method: "statCanonical",
    direction: "out",
    carries: "session metadata",
    gate: "a hub-minted capability grant; answers a size, never bytes",
  },
  {
    method: "signStagingUpload",
    direction: "out",
    carries: "control",
    gate: "a hub-minted grant; mints a signed PUT the client uploads to directly",
  },
  {
    method: "appendChunkToCanonical",
    direction: "in",
    carries: "inbound writes",
    gate: "a hub-minted grant; composes an already-uploaded staging chunk",
  },
  {
    method: "writeArtifact",
    direction: "in",
    carries: "inbound writes",
    gate: "a hub-minted grant, restricted to the allowlisted sidecar names",
  },
  {
    method: "ingestCommit",
    direction: "in",
    carries: "inbound writes",
    gate: "a hub-minted grant; the cloud forwards the transcript it already holds",
  },
  {
    method: "ingestAgentCommit",
    direction: "in",
    carries: "inbound writes",
    gate: "a hub-minted grant; the agent-lane form of ingestCommit",
  },
  {
    method: "deleteSession",
    direction: "in",
    carries: "control",
    gate: "a hub-minted grant; permanently removes one session's objects and rows",
  },
  {
    method: "selfTest",
    direction: "in",
    carries: "control",
    gate: "a hub-minted grant; writes, reads and deletes one throwaway probe object",
  },
];

export interface EgressInputs {
  ui: UiConfig;
  /** The port actually bound, which may differ from the configured one. */
  boundPort: number;
  postgres:
    | { mode: "embedded"; host: string; port: number; database: string }
    | { mode: "external"; host: string; database: string; tls: boolean }
    | { mode: "unknown" };
  /** cloud.url from config.json, or null before enrollment. */
  cloudUrl: string | null;
  /** The base the self-update and the Postgres binaries are fetched from. */
  downloadBase: string | null;
  /** Where the Postgres binaries and the pgvector artifact come from. */
  postgresBinariesUrl: string | null;
  /** The bucket the vault writes to, as resolved. */
  bucket: { provider: string; name: string; region: string | null } | null;
  /** The embedding endpoint, when the embed worker is enabled. */
  embeddingEndpoint: string | null;
  /** True once `ui sso on` has advertised a console URL. */
  ssoAdvertised: boolean;
  /** How long a departed member's roster row is kept, as configured. Stated in
   *  the inbound row because a retention nobody can read is a retention nobody
   *  can check. */
  rosterRetentionDays: number;
}

/** Where the console is reachable from, stated from the resolved bind rather
 *  than from a sentence somebody wrote once about loopback. */
function listenerPeer(ui: UiConfig, boundPort: number): string {
  const loopback = ui.bind === LOOPBACK_BIND || ui.bind === "::1";
  if (loopback) return `${ui.bind}:${boundPort} - this host only`;
  return `${ui.bind}:${boundPort} - every network this host is on`;
}

function listenerNotes(ui: UiConfig, boundPort: number): string[] {
  const notes = [remoteKeySourceLine(ui.trustedProxies)];
  if (ui.publicUrl) {
    notes.push(
      `Published as ${ui.publicUrl}. TLS is terminated by whatever serves that name - this console ` +
        "speaks plain HTTP on its bind address.",
    );
  } else if (ui.bind === LOOPBACK_BIND || ui.bind === "::1") {
    notes.push(
      `No public URL is set, so the console is reachable only from this host or through an SSH ` +
        `forward (ssh -L ${boundPort}:127.0.0.1:${boundPort} <host>).`,
    );
  } else {
    notes.push(
      "No public URL is set and the bind is not loopback: the barrier is the user password over " +
        "whatever ingress fronts this address.",
    );
  }
  return notes;
}

function databaseRow(inputs: EgressInputs): DataPathRow {
  const carries =
    "session metadata, titles, counts - and, in the tables the console is not granted, transcript " +
    "text and embeddings";
  if (inputs.postgres.mode === "external") {
    return {
      id: "metadata-database",
      name: "Metadata database",
      direction: "both",
      peer: `${inputs.postgres.host}/${inputs.postgres.database} (external${inputs.postgres.tls ? ", TLS" : ", no TLS"})`,
      carries,
      gate: "the operator's connection string",
      notes: [
        "An external database is a network destination: these bytes leave this host.",
        inputs.postgres.tls
          ? "The connection asserts TLS."
          : "The connection does NOT assert TLS - set sslmode in the connection string.",
      ],
    };
  }
  if (inputs.postgres.mode === "embedded") {
    return {
      id: "metadata-database",
      name: "Metadata database",
      direction: "both",
      peer: `${inputs.postgres.host}:${inputs.postgres.port}/${inputs.postgres.database} (embedded, loopback)`,
      carries,
      gate: "per-install role passwords, loopback only",
      notes: ["Nothing leaves this host: the embedded server binds loopback and no other interface."],
    };
  }
  return {
    id: "metadata-database",
    name: "Metadata database",
    direction: "both",
    peer: "not resolved yet",
    carries,
    gate: "unknown until the daemon has booted once",
  };
}

/**
 * The inventory, computed. Row ORDER is stable so a reader returning to the page
 * finds the same shape; the SET is authoritative rather than the count.
 */
export function dataPathRows(inputs: EgressInputs): DataPathRow[] {
  const rows: DataPathRow[] = [
    databaseRow(inputs),
    {
      id: "console-listener",
      name: "Console listener",
      direction: "in",
      peer: listenerPeer(inputs.ui, inputs.boundPort),
      carries: "console sign-ins and every page this console serves",
      gate: "a local console account (operator or readonly), password over the chosen ingress",
      notes: listenerNotes(inputs.ui, inputs.boundPort),
    },
    {
      id: "relay-tunnel",
      name: "Served over the relay tunnel (hub-initiated)",
      direction: "both",
      peer: inputs.cloudUrl ?? "not enrolled",
      carries:
        "session bytes on four of these methods, session metadata on three, inbound writes on four",
      gate: "each method's own hub-minted capability grant, verified against the organization key",
      notes: [
        "The hub opens no socket to this host: the fortress dials out, and every call below arrives " +
          "on that one connection.",
        ...RELAY_METHODS.map((m) => `${m.method} (${m.carries}) - ${m.gate}`),
      ],
    },
    {
      id: "console-bucket",
      name: "Console to object storage",
      direction: "both",
      peer: inputs.bucket
        ? `${inputs.bucket.provider}://${inputs.bucket.name}${inputs.bucket.region ? ` (${inputs.bucket.region})` : ""}`
        : "no bucket configured",
      carries: "session transcripts, staging chunks and sidecar artifacts",
      gate: "the fortress storage credential",
      notes: [
        "The console process holds a BUCKET-WRITE-CAPABLE key. The fortress has one credential for " +
          "reads and writes, so there is no narrower one to hold; the only real narrowing is that the " +
          "console is not given the embedding API key.",
      ],
    },
  ];

  rows.push({
    id: "roster-inbound",
    name: "Roster inbound",
    direction: "in",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "the organization's ACTIVE members — external id, display name, email, team names — and a " +
      "per-member device inventory: installs, last seen, last upload and backfill progress",
    gate: "the enrolled organization credential; the hub sends it unasked, on connect and on change",
    notes: [
      "Nothing about a session travels on this path, and nothing travels outward on it: the fortress " +
        "answers no roster question and sends no directory of its own.",
      "Only active members are sent. Somebody who leaves is absent from the next sync rather than " +
        `tombstoned, so this host derives the departure itself and keeps the row for ` +
        `${inputs.rosterRetentionDays} days before removing it.`,
    ],
  });

  rows.push({
    id: "cloud-questions",
    name: "Questions this fortress asks let.ai",
    direction: "out",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "a residency audit's batches of up to 500 session identifiers of the form " +
      "<userId>:<family>:<sessionId>, and a routing-posture request that carries counts and no ids",
    gate: "the enrolled organization credential; the fortress asks and the hub answers — nothing here writes",
    notes: [
      "The only outbound flow that carries per-session identifiers. Only TUNNEL-channel sessions of this " +
        "organization are ever named: a session uploaded straight to this fortress was never told to " +
        "let.ai, so asking about it would disclose it, and an unattributed session is withheld as well.",
      "Every id named here is one let.ai relayed to this host in the first place, so the question " +
        "re-confirms what the hub already holds rather than telling it something new.",
    ],
  });

  rows.push({
    id: "console-url-advertised",
    name: "Console URL advertised to let.ai",
    direction: "out",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries: inputs.ssoAdvertised
      ? `the console's public URL (${inputs.ui.publicUrl ?? "unset"}), and nothing else`
      : "nothing - the console URL is not advertised",
    gate: "`hx-fortress ui sso on`, which requires an https public URL",
    notes: inputs.ssoAdvertised
      ? ["The advertised value is a URL. It conveys no capability: a grant lands on a sign-in form."]
      : ["Turn it off again with `hx-fortress ui sso off`; the button disappears on the next reconnect."],
  });

  rows.push({
    id: "sso-door",
    name: "One-click entry from the workbench",
    direction: "in",
    peer: inputs.ui.publicUrl ?? "not advertised",
    carries: "a signed, single-use grant naming a workbench user and an organization",
    gate: "the organization's signing key, this fortress's own org id, this console's own origin, and a 30-second clock allowance",
    notes: [
      "A valid grant creates NO session and shows NO data: it lands the browser on the sign-in " +
        "form with the workbench identity rendered beside it. Every capability the session ends " +
        "up with comes from the local account whose password is typed there.",
      "The grant is single-use. The workbench identity it carries is recorded alongside whatever " +
        "that sign-in goes on to do.",
    ],
  });

  rows.push({
    id: "enrollment",
    name: "Enrollment",
    direction: "both",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "an enrollment code and, in return, this fortress's identity and its organization credential",
    gate: "a one-time enroll token the operator pastes, or the browser flow that mints one",
    notes: [
      "Runs once, at `hx-fortress enroll`. Nothing about sessions travels on it - it establishes " +
        "which organization this host serves and nothing more.",
      "The signing key and the artifact signature sidecars are fetched over the downloads path " +
        "below, not this one.",
    ],
  });

  rows.push({
    id: "downloads",
    name: "Downloads",
    direction: "out",
    peer: [inputs.downloadBase, inputs.postgresBinariesUrl].filter(Boolean).join(", ") || "none",
    carries: "release binaries, the Postgres runtime and the pgvector artifact",
    gate: "https, a pinned checksum and (from the signing release) a detached signature",
    notes: [
      "The Postgres binaries and the pgvector artifact are fetched from these hosts too, not only the " +
        "fortress binary.",
    ],
  });

  if (inputs.embeddingEndpoint) {
    rows.push({
      id: "embeddings",
      name: "Embedding provider",
      direction: "out",
      peer: inputs.embeddingEndpoint,
      carries: "conversational text, sent to be embedded",
      gate: "the embedding API key, held by the daemon and never by the console",
      notes: [
        "This is the one path on which transcript text leaves the host as text. Point " +
          "FORTRESS_OPENAI_BASE_URL at a zero-retention endpoint if that matters to you.",
      ],
    });
  }

  return rows;
}

/** The method names the inventory claims to cover, for the diff against the
 *  dispatcher's switch. */
export function relayMethodNames(): string[] {
  return RELAY_METHODS.map((m) => m.method).sort();
}
