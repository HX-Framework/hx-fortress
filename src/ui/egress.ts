// Data paths in and out of this host.
//
// The panel used to be called "egress" and listed the flows somebody remembered.
// Both were wrong. It is not egress-only - the roster arrives, the connection carries
// questions inward - and a hand-kept list is a list that goes stale the release
// after it is written, silently, because nothing fails when a flow is missing
// from a page.
//
// So every row here is COMPUTED from effective configuration, and the two rows
// that enumerate call sites are diffed against the code that serves them: the
// row of session calls against the vault RPC switch, the outbound rows against
// the fetch call sites. A flow that exists and is not listed fails a test
// rather than misleading a reader.
//
// The rows say uncomfortable things where they are true. The console process
// holds a bucket-write-capable key, because HX Fortress has ONE credential for
// reads and writes; the metadata database carries transcript text and
// embeddings, whatever the console itself is allowed to read; and the connection row
// does not claim "never transcript objects", because two of the methods it
// serves stream exactly that.

import type { ConnectionView } from "../cloud/counts";
import {
  FRAME_CAP_FOUR_KINDS_BYTES,
  isCarried,
  MESSAGE_KINDS,
  type MessageKind,
  type SessionCallMethod,
} from "../cloud/kinds";
import type { ModuleDataPaths } from "../host/modules-api";
import { hostAndPort } from "../host/reach-address";
import { LEAF_KINDS_IN_WORDS } from "../host/shape";
import type { SecretsConfig } from "../secrets/config";
import { secretProviderDefinition } from "../secrets/providers";
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
export interface SessionCallMethodRow {
  method: SessionCallMethod;
  direction: FlowDirection;
  carries: "session bytes" | "session metadata" | "inbound writes" | "control";
  gate: string;
}

export const SESSION_CALL_METHOD_ROWS: readonly SessionCallMethodRow[] = [
  {
    method: "readChunkText",
    direction: "out",
    carries: "session bytes",
    gate: "a capability grant from the control plane for this session, verified against the org key",
  },
  {
    method: "readCanonical",
    direction: "out",
    carries: "session bytes",
    gate: "a capability grant from the control plane for this session (whole object or a byte range)",
  },
  {
    method: "signCanonicalDownload",
    direction: "out",
    carries: "session bytes",
    gate: "a capability grant from the control plane; the signed URL then bypasses this host entirely",
  },
  {
    method: "readArtifactText",
    direction: "out",
    carries: "session bytes",
    gate: "a capability grant from the control plane, restricted to the allowlisted sidecar names",
  },
  {
    method: "listSessionMetadata",
    direction: "out",
    carries: "session metadata",
    gate: "a grant from the control plane, scoped to one user id",
  },
  {
    method: "listSessions",
    direction: "out",
    carries: "session metadata",
    gate: "a grant from the control plane, scoped to one user id, read from this host's Postgres",
  },
  {
    method: "statCanonical",
    direction: "out",
    carries: "session metadata",
    gate: "a capability grant from the control plane; answers a size, never bytes",
  },
  {
    method: "signStagingUpload",
    direction: "out",
    carries: "control",
    gate: "a grant from the control plane; mints a signed PUT the client uploads to directly",
  },
  {
    method: "appendChunkToCanonical",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane; composes an already-uploaded staging chunk",
  },
  {
    method: "writeArtifact",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane, restricted to the allowlisted sidecar names",
  },
  {
    method: "ingestCommit",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane; the control plane forwards the transcript it already holds",
  },
  {
    method: "ingestAgentCommit",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane; the agent-lane form of ingestCommit",
  },
  {
    method: "reindexCanonical",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane; re-indexes a canonical this host ALREADY holds — no transcript crosses the wire (bytes-free)",
  },
  {
    method: "updateSessionTitle",
    direction: "in",
    carries: "inbound writes",
    gate: "a grant from the control plane; CAS-upgrades one session's fallback title to the client's own name — metadata only, no transcript crosses the wire",
  },
  {
    method: "deleteSession",
    direction: "in",
    carries: "control",
    gate: "a grant from the control plane; permanently removes one session's objects and rows",
  },
  {
    method: "selfTest",
    direction: "in",
    carries: "control",
    gate: "no grant; writes, reads and deletes one throwaway probe object, and reads no session",
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
  /** The control plane's address (cloud.url in config.json), or null before enrollment. */
  cloudUrl: string | null;
  /** Whether the Agentic Sessions module is on. Null or absent when it is not known,
   *  and then the rows read as they do with Agentic Sessions on. */
  sessions?: "on" | "off" | null;
  /** What the connection may carry and what it carried today. Absent on a
   *  caller that predates the row. `state` is null when the running daemon has
   *  not said: the row then states the rule and no state. `counts` is null
   *  when nothing was counted today, and `"unreadable"` when the file of counts
   *  is there and cannot be used. */
  connection?: {
    state: ConnectionView["sessionContent"] | null;
    counts: ConnectionView | null | "unreadable";
  };
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
  /** What the control plane may ask this host's modules, where a release file may be
   *  fetched from, and where a module may call. Left out by a caller that does
   *  not compute it: the three module rows are then listed as not resolved,
   *  never left off the page. */
  modules?: ModuleDataPaths;
  /** Where this HX Fortress reads secrets by name, as resolved. Null when the
   *  settings could not be read. Absent on a caller that predates the row. */
  secrets?: SecretsConfig | null;
  /** The names of the secrets this HX Fortress reads. Names only. */
  secretNames?: readonly string[];
  /** Sign-in through the organization's identity provider, as configured.
   *  Absent on a caller that predates the row. */
  oidc?: { enabled: boolean; issuer: string | null };
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
 * The three paths modules add: what the control plane may ask a module, where a release
 * file for a module is fetched from, and where a module may call.
 *
 * Computed from the modules that are switched on. A module that is off answers
 * nothing and calls nothing, so it adds nothing here.
 */
function moduleRows(inputs: EgressInputs): DataPathRow[] {
  const modules = inputs.modules ?? null;
  const unresolved = "not resolved yet";
  const asking = (modules?.on ?? []).filter((module) => module.asks.length > 0);
  const askCount = asking.reduce((count, module) => count + module.asks.length, 0);
  const releasePeers = modules
    ? [modules.controlPlaneOrigin, ...modules.releaseHosts.map((host) => `https://${host}`)].filter(Boolean)
    : [];
  const calling = (modules?.on ?? []).filter((module) => module.egress.length > 0);
  const calledHosts = [...new Set(calling.flatMap((module) => module.egress))].sort();

  return [
    {
      id: "module-asks",
      name: "Asks the control plane sends a module",
      direction: "both",
      peer: inputs.cloudUrl ?? "not enrolled",
      carries:
        modules === null
          ? unresolved
          : asking.length === 0
            ? "nothing - no module that takes asks is switched on"
            : `the answers to ${askCount} ${askCount === 1 ? "ask" : "asks"} of ` +
              `${asking.map((module) => module.id).join(", ")}: ${LEAF_KINDS_IN_WORDS}, ` +
              "with no field for free text or bytes",
      gate:
        "a grant signed with the organization key for one module, one ask and one set of " +
        "arguments, valid for at most 60 seconds and usable once; and the module's switch on this host",
      notes: [
        "An ask arrives on the connection this HX Fortress opened. The list of asks is compiled into " +
          "this binary, and `hx-fortress modules list` prints it.",
        ...asking.flatMap((module) =>
          module.asks.map((ask) => `${module.id} ${ask.name} - the answer holds ${ask.reply}`),
        ),
      ],
    },
    {
      id: "module-releases",
      name: "Releases the control plane offers a module",
      direction: "in",
      peer:
        modules === null
          ? unresolved
          : releasePeers.length > 0
            ? releasePeers.join(", ")
            : "not enrolled",
      carries:
        "a signed file for a module that is switched on" +
        (modules ? `, at most ${Math.floor(modules.releaseMaxBytes / (1024 * 1024))} MiB` : "") +
        ", kept until somebody on this host approves or refuses it",
      gate:
        "a signature by a key compiled into this binary, over the module, the version and the " +
        "file's sha256, verified before the download; then `hx-fortress releases approve` on this host",
      notes: [
        "HX Fortress never runs the file. An approved release is handed to its module, and the " +
          "module's code came with this binary.",
        "A download is made only from the control plane's own origin or a host listed in " +
          "FORTRESS_RELEASE_HOSTS, and a redirect is held to the same rule.",
        ...(modules === null
          ? []
          : [
              modules.releaseHostsFrom === "daemon"
                ? "The hosts shown are the ones the daemon was last started with. The daemon is " +
                  "what downloads, so its setting is the one that counts."
                : "No daemon has started on this host yet, so the hosts shown are read from this " +
                  "console's own environment. The daemon's setting is the one that counts.",
            ]),
      ],
    },
    {
      id: "module-egress",
      name: "Hosts a module may call",
      direction: "out",
      peer:
        modules === null
          ? unresolved
          : calledHosts.length > 0
            ? calledHosts.join(", ")
            : "none - no module that is switched on lists a host",
      carries: "what a module sends to a host on its own list",
      gate:
        "the module's list of hosts, compiled into this binary: https only, never a host written " +
        "as an address in a private range, and a redirect is not followed",
      notes: calling.map((module) => `${module.id} may call ${module.egress.join(", ")}`),
    },
    ...personRows(inputs),
  ];
}

/**
 * The two paths a person's act adds: the act itself, which crosses from the
 * console to the daemon on this machine, and the hosts a person added for a
 * module.
 *
 * Listed only while a module that takes acts is switched on. With no such
 * module there is no door on this machine and no list of hosts, and the page
 * reads as it did before there were acts.
 */
function personRows(inputs: EgressInputs): DataPathRow[] {
  const acting = (inputs.modules?.on ?? []).filter((module) => (module.acts?.length ?? 0) > 0);
  if (acting.length === 0) return [];
  const actCount = acting.reduce((count, module) => count + (module.acts?.length ?? 0), 0);
  const unreadable = acting.filter((module) => module.reaches === "unreadable").map((module) => module.id);
  const reaches = acting.flatMap((module) =>
    Array.isArray(module.reaches) ? module.reaches.map((reach) => ({ module: module.id, ...reach })) : [],
  );
  const hosts = [...new Set(reaches.map((reach) => hostAndPort(reach.host, reach.port)))].sort();
  const programs = acting.flatMap((module) => (module.programs ?? []).map((program) => ({ module: module.id, ...program })));
  return [
    {
      id: "module-acts",
      name: "What a signed-in person may have a module do",
      direction: "in",
      peer: "this machine only: the daemon listens on 127.0.0.1 for this console, and on no other address",
      carries:
        `${actCount} ${actCount === 1 ? "act" : "acts"} of ${acting.map((module) => module.id).join(", ")}, ` +
        `and each one's reply: ${LEAF_KINDS_IN_WORDS}, with no field for free text or bytes`,
      gate:
        "the person's sign-in at this console, and for an act of operators the operator role. " +
        "The daemon checks the role again, and checks the act and its arguments. The console proves to " +
        "the daemon that it holds a secret, which is in a file only this HX Fortress's own user can read. " +
        "The secret itself is not sent",
      notes: [
        "A control plane cannot send an act: no message on the connection leads to one.",
        "An act of an operator is recorded in the audit trail under the person's login before it runs. " +
          "An act that every signed-in person may do is not recorded one by one, and it cannot change " +
          "the hosts or the names of secrets that a person added.",
        "The request and the reply cross in memory: HX Fortress writes neither of them, as such, to a " +
          "table or a file. What an act changes is written, and so is the audit record of the act.",
        ...acting.flatMap((module) =>
          (module.acts ?? []).map(
            (act) => `${module.id} ${act.name} - ${act.role === "operator" ? "operators only" : "every signed-in person"}`,
          ),
        ),
      ],
    },
    {
      id: "module-reach",
      name: "Hosts a person added for a module",
      direction: "out",
      peer:
        hosts.length > 0
          ? hosts.join(", ")
          : unreadable.length > 0
            ? "not readable"
            : "none - no person has added one",
      carries:
        programs.length > 0
          ? "what a module's helper program sends to the database there: its sign-in with the login whose " +
            "secret the connection names, and the statements of its one job. What it reads comes back to the " +
            "module on this machine. For a test of a connection that is the names of the tables and of their columns"
          : "nothing: no module that is on has the host run a helper program",
      // The page puts "authorized by" in front of this.
      gate:
        "an operator signed in to this console, who added each one. Each is recorded under that person's " +
        "login. What was typed is checked when it is added: a loopback, link-local or multicast address, " +
        "a cloud's metadata address or name, and localhost are refused. The address that a name leads to " +
        "is looked up each time a program is sent there, and held to the same rule. This machine's own " +
        "address on its network is not recognised",
      notes: [
        ...programs.map(
          (program) =>
            `${program.module}: the daemon runs ${program.title} for it, the file that ${program.pathVariable} names in ` +
            "the daemon's own environment. It is started with fixed arguments and no shell, and is given one job on " +
            "its standard input: the address, the login and its password. Of the daemon's environment it is given " +
            "PATH, SSL_CERT_FILE and SSL_CERT_DIR, and nothing else. Each run is a pair of records in the audit trail",
        ),
        ...(programs.length > 0
          ? [
              "Before each run the daemon asks this machine's own resolver for the address of the host's name. " +
                "That question holds the host's name and nothing else, and it goes to the name servers this machine uses",
            ]
          : []),
        ...unreadable.map(
          (module) => `${module}: its list of hosts is on the disk and cannot be read, so none of its entries is used`,
        ),
        ...reaches.map(
          (reach) =>
            `${reach.module}: ${reach.name} is ${hostAndPort(reach.host, reach.port)}, added by ${reach.addedBy} on ${reach.addedAt.slice(0, 10)}`,
        ),
        ...acting.flatMap((module) =>
          module.addedSecretNames === "unreadable"
            ? [`${module.id}: its list of secret names is on the disk and cannot be read, so no name on it is used`]
            : (module.addedSecretNames?.length ?? 0) > 0
              ? [
                  `${module.id}: names of secrets a person added: ` +
                    `${(module.addedSecretNames as string[]).join(", ")}. Names only. A name that a ` +
                    "setting of this HX Fortress names too is not read for the module",
                ]
              : [],
        ),
      ],
    },
  ];
}

/**
 * Where secrets that are read by name come from.
 *
 * Each provider says this about itself (`path` in its definition). A provider
 * that reads over the network is a data path of its own. With one that reads
 * on this host nothing leaves it, and the row says so.
 */
function secretStoreRow(inputs: EgressInputs): DataPathRow {
  const names = inputs.secretNames ?? [];
  const reads =
    names.length > 0
      ? `Read by name on this host: ${names.join(", ")}.`
      : "This console sees no setting that is given by secret name.";
  const base = { id: "secret-store", name: "Secret store" } as const;
  const carries = "the values of the secrets this HX Fortress reads by name";
  const config = inputs.secrets;
  const definition = config ? secretProviderDefinition(config.provider) : null;
  if (!config || !definition) {
    return {
      ...base,
      direction: "in",
      peer: "not resolved",
      carries,
      gate: "unknown: the secrets settings of this host could not be read",
      notes: [reads],
    };
  }
  const path = definition.path(config);
  return {
    ...base,
    direction: path.leavesHost ? "both" : "in",
    peer: path.peer,
    carries: path.carries ?? carries,
    gate: path.gate,
    notes: [reads, ...path.notes],
  };
}

/** Whether a kind is carried, as the page knows it: by the state the running
 *  daemon published and by whether Agentic Sessions is on, under the connection's own
 *  rule. Null when the page does not know enough to say. */
function carriedNow(kind: MessageKind, inputs: EgressInputs): boolean | null {
  const state = inputs.connection?.state ?? null;
  if (kind.when !== "always" && state === null) return null;
  const sessionContent = state === "on" || state === "off" ? state : null;
  const sessionsKnown = inputs.sessions === "on" || inputs.sessions === "off";
  if (kind.when === "sessions" && sessionContent !== null && !sessionsKnown) return null;
  return isCarried(kind, { sessions: inputs.sessions === "on", sessionContent });
}

/** When a kind is carried, as a sentence after what it holds. Where nobody
 *  chose, every kind is carried whatever the Agentic Sessions module is, so
 *  the line must not say "only while". */
function whenCarried(kind: MessageKind, state: ConnectionView["sessionContent"] | null): string {
  if (kind.when === "always") return "";
  if (state === "not_set") {
    return kind.when === "sessions"
      ? ". Carried whether Agentic Sessions is on or off, as before the choice about session content existed"
      : ". Carried, as before the choice about session content existed";
  }
  // Not known: the daemon has not said, so both cases are stated.
  if (state === null) {
    return kind.when === "sessions"
      ? ". Where session content is on or off: only while Agentic Sessions is on. Where nobody chose: always"
      : ". Only while session content is on, or where nobody chose about it";
  }
  return kind.when === "sessions" ? ". Only while Agentic Sessions is on" : ". Only while session content is on";
}

/** How many of the session call methods carry one thing, as a word. */
function methodsThatCarry(what: SessionCallMethodRow["carries"]): string {
  const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const count = SESSION_CALL_METHOD_ROWS.filter((row) => row.carries === what).length;
  // `count` is a small whole number: an index of this function's own list.
  // eslint-disable-next-line security/detect-object-injection
  return words[count] ?? String(count);
}

const kib = (bytes: number): string => `${Math.floor(bytes / 1024)} KiB`;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** How to make the choice, for an HX Fortress where nobody made it. The variable
 *  is read by the daemon, and a daemon that runs as a service does not get the
 *  variables of the shell that installed it. */
const HOW_TO_CHOOSE =
  'Choose off or on: `connection.sessionContent` in config.json, or FORTRESS_CONNECTION_SESSION_CONTENT ' +
  "in the daemon's own environment, and then restart the daemon.";

/**
 * The connection itself: every kind of message it can carry, which of them it
 * carries now, and what it counted today.
 *
 * The kinds come from the one table the connection sorts frames by, so this
 * row cannot list a kind the connection does not know, or miss one it does.
 */
function connectionRow(inputs: EgressInputs): DataPathRow {
  const state = inputs.connection?.state ?? null;
  const counts = inputs.connection?.counts ?? null;
  const carried = MESSAGE_KINDS.filter((kind) => carriedNow(kind, inputs) !== false);
  const notCarried = MESSAGE_KINDS.filter((kind) => carriedNow(kind, inputs) === false);
  const stateLine =
    state === "off"
      ? "Session content is off on this connection. A call that reads or writes a session, and a call of one " +
        "of this HX Fortress's tools, is refused by the connection itself, and each refusal is recorded." +
        // The small cap holds only where nothing large is carried: see frameCapBytes.
        (inputs.sessions === "off"
          ? ` A message over ${kib(FRAME_CAP_FOUR_KINDS_BYTES)} is dropped before it is parsed.`
          : "")
      : state === "on"
        ? "Session content is on for this connection. A call that reads or writes a session, and a call of " +
          "one of this HX Fortress's tools, is served only with a grant signed by the control plane. Two calls " +
          "need no grant and read no session: `selfTest`, and the list of this HX Fortress's tools."
        : state === "not_set"
          ? "Nobody chose whether session content may travel on this connection, so it carries what it " +
            `carried before that choice existed. ${HOW_TO_CHOOSE}`
          : "The running daemon has not said whether session content may travel on this connection.";
  const countLines: string[] = [];
  if (counts === "unreadable") {
    countLines.push("The counts of this connection's messages are on this host and could not be read.");
  } else if (counts === null) {
    countLines.push("Nothing was counted on this connection today.");
  } else {
    countLines.push(
      `Counted today, ${counts.since.slice(0, 10)} (a day in UTC), on this host, by the name of each message:`,
    );
    for (const kind of MESSAGE_KINDS) {
      const frames = counts.messages.filter((message) => message.kind === kind.id);
      if (frames.length === 0) continue;
      countLines.push(
        `${kind.title} - ` +
          frames
            .map(
              (frame) =>
                `${frame.frame} ${frame.direction} ${frame.count}` +
                (frame.refused > 0 ? `, refused ${frame.refused}` : ""),
            )
            .join("; "),
      );
    }
    const { tooLarge, unreadable, unknown } = counts.dropped;
    if (tooLarge + unreadable + unknown > 0) {
      countLines.push(
        `Dropped without an answer - over the size limit ${tooLarge}, not readable as a message ${unreadable}, ` +
          `a name this build does not know ${unknown}`,
      );
    }
  }
  return {
    id: "connection",
    name: "The connection to the control plane",
    direction: "both",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      `${carried.length} of ${MESSAGE_KINDS.length} kinds of message: ` +
      carried.map((kind) => lowerFirst(kind.title)).join("; "),
    // Read after "authorized by".
    gate:
      "this HX Fortress's enrolled credential, on a connection that this HX Fortress opens outbound; " +
      "the control plane opens no connection to this host",
    notes: [
      stateLine,
      ...MESSAGE_KINDS.map(
        (kind) =>
          `${kind.title} (${[...kind.in.map((frame) => `${frame} in`), ...kind.out.map((frame) => `${frame} out`)].join(", ")}) - ` +
          `${kind.holds}` +
          whenCarried(kind, state),
      ),
      ...(notCarried.length > 0
        ? [`Not carried now: ${notCarried.map((kind) => lowerFirst(kind.title)).join("; ")}.`]
        : []),
      ...countLines,
    ],
  };
}

/** The calls that read or write a session, method by method. */
function sessionCallsRow(inputs: EgressInputs): DataPathRow {
  const sessionsOff = inputs.sessions === "off";
  const state = inputs.connection?.state ?? null;
  const refusedByConnection = state === "off";
  return {
    id: "session-calls",
    name: "Session calls served over the connection to the control plane",
    direction: "both",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries: refusedByConnection
      ? "nothing - session content is off on the connection, so the connection refuses each method below"
      : sessionsOff
        ? "nothing while Agentic Sessions is off - each method below needs sessions and is answered with a refusal"
        : `session bytes on ${methodsThatCarry("session bytes")} of these methods, session metadata on ` +
          `${methodsThatCarry("session metadata")}, inbound writes on ${methodsThatCarry("inbound writes")}`,
    // Read after "authorized by".
    gate: refusedByConnection
      ? "nothing: the connection refuses each of these calls before a grant is looked at"
      : state === "on"
        ? "a grant signed by the control plane and verified against the organization key, on every call " +
          "but `selfTest`"
        : state === "not_set"
          ? "a grant signed by the control plane, verified against the organization key whenever one is sent; " +
            "a call with no grant is served unless the daemon runs with FORTRESS_TUNNEL_GRANT_ENFORCE"
          : // Not known: the daemon has not said. Nothing is claimed about a call with no grant.
            "a grant signed by the control plane, verified against the organization key, where a call is " +
            "served. Whether a call with no grant is served is not known here: the running daemon has not " +
            "said what its connection carries",
    notes: [
      "The control plane opens no socket to this host: this HX Fortress dials out, and every call below arrives " +
        "on that one connection.",
      ...(refusedByConnection
        ? ["Session content is off on this connection. None of these methods is served, and each refusal is recorded."]
        : []),
      ...(sessionsOff && !refusedByConnection
        ? ["Agentic Sessions is off on this HX Fortress. It stores no session, so none of these methods is served."]
        : []),
      refusedByConnection
        ? "This HX Fortress's tools are called over the same connection (`mcpRpc`), and the connection refuses " +
          "those calls too."
        : "This HX Fortress's tools are called over the same connection (`mcpRpc`), under the same rule, except " +
          "that listing the tools needs no grant. The answer of a tool is free text.",
      // What authorizes a method is said only where the method is served.
      ...SESSION_CALL_METHOD_ROWS.map((m) =>
        refusedByConnection ? `${m.method} (${m.carries})` : `${m.method} (${m.carries}) - ${m.gate}`,
      ),
    ],
  };
}

/**
 * The inventory, computed. Row ORDER is stable so a reader returning to the page
 * finds the same shape; the SET is authoritative rather than the count.
 */
export function dataPathRows(inputs: EgressInputs): DataPathRow[] {
  const sessionsOff = inputs.sessions === "off";
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
    connectionRow(inputs),
    sessionCallsRow(inputs),
    {
      id: "console-bucket",
      name: "Console to object storage",
      direction: "both",
      peer: sessionsOff
        ? "none - Agentic Sessions is off"
        : inputs.bucket
          ? `${inputs.bucket.provider}://${inputs.bucket.name}${inputs.bucket.region ? ` (${inputs.bucket.region})` : ""}`
          : "no bucket configured",
      carries: sessionsOff ? "nothing" : "session transcripts, staging chunks and sidecar artifacts",
      gate: sessionsOff ? "none" : "this HX Fortress's storage credential",
      notes: sessionsOff
        ? [
            "Agentic Sessions is off, so this HX Fortress serves no bucket. A credentials file left by an earlier " +
              "setup is not read by the daemon or by this console.",
          ]
        : [
            "The console process holds a BUCKET-WRITE-CAPABLE key. HX Fortress has one credential for " +
              "reads and writes, so there is no narrower one to hold; the only real narrowing is that the " +
              "console is not given the embedding API key.",
          ],
    },
  ];

  rows.push(secretStoreRow(inputs));

  rows.push({
    id: "identity-provider",
    name: "Sign-in through your identity provider",
    direction: "both",
    peer: inputs.oidc?.issuer ?? "not configured",
    carries: inputs.oidc?.enabled
      ? "a one-time sign-in code and this console's client id go out, and its client secret when it " +
        "has one; an ID token comes back with the person's id at the provider, their login and " +
        "their group names"
      : "nothing - this sign-in is off",
    gate: "`hx-fortress ui oidc on` on this host, then the provider's signature on each ID token",
    notes: [
      "The provider is the organization's own. No control plane is on this path. None can turn " +
        "this on or mint a session through it.",
      "The console calls the provider's discovery document, its signing keys and its token endpoint. " +
        "The ID token is checked here and is not sent to the browser.",
    ],
  });

  rows.push({
    id: "roster-inbound",
    name: "Roster inbound",
    direction: "in",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "the organization's ACTIVE members — external id, display name, email, team names — and a " +
      "per-member device inventory: installs, last seen, last upload and backfill progress",
    gate: "the enrolled organization credential; the control plane sends it unasked, on connect and on change",
    notes: [
      "Nothing about a session travels on this path, and nothing travels outward on it: HX Fortress " +
        "answers no roster question and sends no directory of its own.",
      "Only active members are sent. Somebody who leaves is absent from the next sync rather than " +
        `tombstoned, so this host derives the departure itself and keeps the row for ` +
        `${inputs.rosterRetentionDays} days before removing it.`,
    ],
  });

  rows.push({
    id: "cloud-questions",
    name: "Questions this HX Fortress asks the control plane",
    direction: "out",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "a residency audit's batches of up to 500 session identifiers of the form " +
      "<userId>:<family>:<sessionId>, and a routing-posture request that carries counts and no ids",
    gate: "the enrolled organization credential; HX Fortress asks and the control plane answers — nothing here writes",
    notes: [
      "The only outbound flow that carries per-session identifiers. Only TUNNEL-channel sessions of this " +
        "organization are ever named: a session uploaded straight to this HX Fortress was never told to " +
        "the control plane, so asking about it would disclose it, and an unattributed session is withheld as well.",
      "Every id named here is one the control plane sent to this host in the first place, so the question " +
        "re-confirms what it already holds rather than telling it something new.",
    ],
  });

  rows.push(...moduleRows(inputs));

  rows.push({
    id: "console-url-advertised",
    name: "Console URL advertised to the control plane",
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
    name: "One-click entry from the control plane",
    direction: "in",
    peer: inputs.ui.publicUrl ?? "not advertised",
    carries: "a signed, single-use grant naming a person at the control plane and an organization",
    gate: "the organization's signing key, this HX Fortress's own org id, this console's own origin, and a 30-second clock allowance",
    notes: [
      "A valid grant creates NO session and shows NO data: it lands the browser on the sign-in " +
        "form with that person's identity at the control plane rendered beside it. Every capability the session ends " +
        "up with comes from the local account whose password is typed there.",
      "The grant is single-use. The identity it carries is recorded alongside whatever " +
        "that sign-in goes on to do.",
    ],
  });

  rows.push({
    id: "enrollment",
    name: "Enrollment",
    direction: "both",
    peer: inputs.cloudUrl ?? "not enrolled",
    carries:
      "an enrollment code and, in return, this HX Fortress's identity and its organization credential",
    gate: "a one-time enrollment token the operator pastes, or the browser flow that mints one",
    notes: [
      "Runs once, at `hx-fortress enroll` or at the last question of `hx-fortress setup`. Nothing " +
        "about sessions travels on it - it establishes which organization this host serves and " +
        "nothing more.",
      "The signing key and the artifact signature sidecars are fetched over the downloads path " +
        "below, not this one.",
    ],
  });

  rows.push({
    id: "setup-checks",
    name: "The setup's checks",
    direction: "out",
    peer: "each address the setup's answers name",
    carries:
      "a request that asks whether the address answers, and nothing this HX Fortress stores. When the " +
      "answer about the AI model is given, one fixed word is sent to that model with its key",
    gate: "`hx-fortress setup` on this host, and the Checkup",
    notes: [
      "A check reads the sign-in provider's own description of itself, asks the key store for " +
        "each key an answer names, and sends a HEAD request to each address the answers add to the " +
        "network list. A key store answers by reading the key, as it does at every start; what " +
        "the check keeps is only whether the key is there. What an address sends back is not kept " +
        "and not shown: a check says what it found in a sentence of its own.",
      "A start of HX Fortress makes the checks again and sends nothing: it checks only what this " +
        "host can see by itself. So does a check made while a person is still typing an answer. " +
        "The Checkup asks the sign-in provider and the key store, and nothing else.",
      "The database, the file store and the AI model are asked by a check only when a person " +
        "has given the setup an answer. At a start and in the Checkup HX Fortress's own probes " +
        "cover the first two.",
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
      "The Postgres binaries and the pgvector artifact are fetched from these hosts too, not only the binary " +
        "of HX Fortress itself.",
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
export function sessionCallMethodNames(): string[] {
  return SESSION_CALL_METHOD_ROWS.map((m) => m.method).sort();
}
