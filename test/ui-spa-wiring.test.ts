// The console SPA, held to the four properties a reader cannot check by looking.
//
// Every gate here exists because the prototype shipped the opposite: mock data
// behind real-looking numbers, thirty-four innerHTML sinks, a PDF assembled in
// the tab, a disclosure sentence written four different ways, and a retention
// figure typed into a view. A page can regrow any of them without a test
// failing, which is why these are greps over the source rather than assertions
// about behaviour.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISCLOSURE_LITERALS,
  DISCLOSURE_CANONICAL,
} from "../ui/src/disclosure";
import {
  COMMAND_SURFACE_NOTE,
  OPS_LEDE_CONTAINER,
  OPS_LEDE_HOST,
  opsLede,
} from "../ui/src/copy";
import {
  BOOTSTRAP_PATH,
  formatPath,
  parsePath,
  peekFragmentToken,
  NAV_VIEWS,
} from "../ui/src/router";
import { CLI_HELP, helpEntries, renderHelp } from "../src/ui/help";
import { READ_AUDITED_PATHS, READ_PATHS } from "../src/ui/read-routes";
import { EVENT_STREAM_CLIENT_CONTRACT } from "../src/ui/events";
import { PUBLIC_ROUTES, RouteRegistry } from "../src/ui/routes";
import { READONLY_REFUSAL_COPY } from "../src/ui/copy";
import { setupUrl } from "../src/ui/users";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const spaRoot = path.join(repoRoot, "ui", "src");

/** The disclosure module, named once. Every gate below is scoped to the source
 *  OUTSIDE it — a module that could not state its own subject would be a strange
 *  thing to protect. */
const DISCLOSURE_MODULE = path.join(spaRoot, "disclosure.ts");

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (/\.(ts|tsx|css|html)$/.test(entry)) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

const FILES = sourceFiles(spaRoot).map((file) => ({
  file,
  rel: path.relative(repoRoot, file),
  text: readFileSync(file, "utf8"),
}));

const CODE = FILES.filter((f) => /\.tsx?$/.test(f.file));

describe("the mock layers are gone", () => {
  test("nothing imports the prototype's data or rendering modules", () => {
    for (const { rel, text } of CODE) {
      expect(text).not.toMatch(/from "\.\.?\/(data|render|icons)"/);
      expect(`${rel}:${/FORT\b/.test(text)}`).toBe(`${rel}:false`);
    }
    for (const name of ["data.ts", "render.ts", "icons.ts", "lib/pdf.ts"]) {
      expect(FILES.some((f) => f.rel.endsWith(`ui/src/${name}`))).toBe(false);
    }
  });

  test("no demo world survives anywhere in the console", () => {
    // The prototype's fabricated organization, host, people and identifiers. A
    // single one of these reaching a shipped console would put a customer's
    // console in front of another company's name.
    const demo = [
      "Orange Corp",
      "orange-corp",
      "Dana Mandarin",
      "dana.mandarin",
      "fortress-01",
      "vault_93cc",
      "Marta Nilsson",
      "hxframework.org",
      "github.com/hx-framework",
    ];
    for (const { rel, text } of FILES) {
      for (const token of demo) {
        expect(`${rel} contains ${token}: ${text.includes(token)}`).toBe(
          `${rel} contains ${token}: false`,
        );
      }
    }
  });

  test("no markup sink and no outbound link", () => {
    for (const { rel, text } of CODE) {
      expect(`${rel}:${text.includes("dangerouslySetInnerHTML")}`).toBe(`${rel}:false`);
      expect(`${rel}:${text.includes("innerHTML")}`).toBe(`${rel}:false`);
      // A console served by an appliance with no egress must not link off the
      // box: the link would simply hang, and it would leak a page load.
      expect(`${rel}:${/href="https?:/.test(text)}`).toBe(`${rel}:false`);
    }
  });
});

describe("the client is bound to the read API", () => {
  test("every read route the server registers is reachable from the client", () => {
    const client = FILES.find((f) => f.rel.endsWith("ui/src/api.ts"));
    expect(client).toBeDefined();
    for (const value of [...Object.values(READ_PATHS), ...Object.values(READ_AUDITED_PATHS)]) {
      expect(`${value}: ${(client as { text: string }).text.includes(value)}`).toBe(
        `${value}: true`,
      );
    }
  });

  test("the session rides a header, per tab, and never a cookie", () => {
    const client = (FILES.find((f) => f.rel.endsWith("ui/src/api.ts")) as { text: string }).text;
    expect(client).toContain(EVENT_STREAM_CLIENT_CONTRACT.header);
    expect(client).toContain("sessionStorage");
    expect(EVENT_STREAM_CLIENT_CONTRACT.tokenMedium).toBe("sessionStorage");
    for (const { rel, text } of CODE) {
      // The word may appear in a comment saying why it is not used; the CALL
      // may not appear at all.
      expect(`${rel}:${/\blocalStorage\s*[.[]/.test(text)}`).toBe(`${rel}:false`);
      expect(`${rel}:${/document\.cookie/.test(text)}`).toBe(`${rel}:false`);
    }
  });

  test("the client closes its stream when the tab is hidden", () => {
    const client = (FILES.find((f) => f.rel.endsWith("ui/src/api.ts")) as { text: string }).text;
    expect(client).toContain(EVENT_STREAM_CLIENT_CONTRACT.closeOn);
    expect(client).toContain(EVENT_STREAM_CLIENT_CONTRACT.resumeHeader);
  });
});

describe("no artifact is generated in the browser", () => {
  test("the report and the PDF have no client-side renderer", () => {
    for (const { rel, text } of CODE) {
      expect(`${rel}:${text.includes("reportPdfBytes")}`).toBe(`${rel}:false`);
      expect(`${rel}:${text.includes("%PDF")}`).toBe(`${rel}:false`);
      expect(`${rel}:${text.includes("downloadBlob")}`).toBe(`${rel}:false`);
    }
  });

  test("the generated artifacts come from the server's own endpoints", () => {
    const compliance = (FILES.find((f) => f.rel.endsWith("views/Compliance.tsx")) as { text: string })
      .text;
    expect(compliance).toContain("API.reportPdf");
    expect(compliance).toContain("api.report()");
    const logs = (FILES.find((f) => f.rel.endsWith("views/Logs.tsx")) as { text: string }).text;
    // The range export is the audited server endpoint; the local save only
    // re-saves rows already delivered and already on screen.
    expect(logs).toContain("API.logsExport");
    expect(logs).toContain("saveRenderedRows");
  });
});

// ── the disclosure gate ──────────────────────────────────────────────────────

/**
 * The gate, defined by CLAIM SHAPE rather than by wording.
 *
 * The second arm exists because the claim is also written the other way round —
 * "transcript content never appears here" — and a one-armed pattern misses it
 * entirely, which is the failure mode a gate must not have.
 */
const DISCLOSURE_CLAIM =
  /never\s+(the\s+)?(content|transcript)|metadata only|no titles|no paths|(transcript|conversation)\s+(content|text|bodies)[^.]{0,40}\bnever\b/i;

/**
 * Structural mentions that are inventory text rather than claims.
 *
 * Entries are exact source substrings, and every one of them must still be
 * present — an allowlist that outlives the line it excused is a hole nobody is
 * watching. It is empty today because every claim-shaped sentence in the console
 * now comes from the disclosure module; a page that needs to NAME the boundary
 * without asserting it adds its line here, with a reason.
 */
const DISCLOSURE_ALLOWLIST: readonly string[] = [];

describe("the disclosure is single-sourced", () => {
  test("the gate matches every literal the module publishes", () => {
    for (const literal of DISCLOSURE_LITERALS) {
      expect(`${JSON.stringify(literal)} matched: ${DISCLOSURE_CLAIM.test(literal)}`).toBe(
        `${JSON.stringify(literal)} matched: true`,
      );
    }
  });

  test("the gate would have matched every literal it replaced", () => {
    // The prototype's own sentences, frozen here. A gate that could not match
    // the strings it was written to find would pass over a page that dropped the
    // claim entirely, so the pattern is proved against them rather than trusted.
    const replaced = [
      "session metadata only — never transcript content",
      "This console is served from the fortress itself and shows session metadata only. Transcript content never appears here.",
      "this console shows the metadata, never the content",
      "metadata only",
      "Transcript content rests in the bucket and is never displayed here.",
      "titles and counts, never content",
      "Titles, counts and locations are metadata — transcript content never appears in this console",
    ];
    for (const literal of replaced) {
      expect(`${JSON.stringify(literal)} matched: ${DISCLOSURE_CLAIM.test(literal)}`).toBe(
        `${JSON.stringify(literal)} matched: true`,
      );
    }
  });

  test("no claim of that shape exists outside the module", () => {
    for (const entry of DISCLOSURE_ALLOWLIST) {
      expect(CODE.some((f) => f.text.includes(entry))).toBe(true);
    }
    const offenders: string[] = [];
    for (const { file, rel, text } of FILES) {
      if (file === DISCLOSURE_MODULE) continue;
      text.split("\n").forEach((line, i) => {
        if (!DISCLOSURE_CLAIM.test(line)) return;
        if (DISCLOSURE_ALLOWLIST.some((entry) => line.includes(entry))) return;
        offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the canonical sentence names both halves of the boundary", () => {
    expect(DISCLOSURE_CANONICAL).toContain("session metadata and derived titles");
    expect(DISCLOSURE_CANONICAL).toContain("never transcript bodies");
  });
});

// ── retention ────────────────────────────────────────────────────────────────

describe("retention is derived, never typed", () => {
  test("no day-count survives in the console's source", () => {
    // "90 days on disk" and "180-day trail" stayed plausible for years after the
    // policy underneath them changed. Every retention figure now comes from the
    // server's derived facts.
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      text.split("\n").forEach((line, i) => {
        if (/\b\d+\s*-?\s*day\b/i.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the retention rows render the server's own strings", () => {
    const compliance = (FILES.find((f) => f.rel.endsWith("views/Compliance.tsx")) as { text: string })
      .text;
    expect(compliance).toContain("data.retention.logs");
    expect(compliance).toContain("data.retention.auditTrail");
    expect(compliance).toContain("storage.lifecycle");
    expect(compliance).toContain("storage.versioning");
  });
});

// ── parity ───────────────────────────────────────────────────────────────────

describe("the Ops lede is stated once, with both arms", () => {
  test("the host arm names the verb families a host owns", () => {
    expect(OPS_LEDE_HOST).toContain("service, update, credential and diagnostic verbs");
    expect(OPS_LEDE_HOST).toContain("console sign-in sessions");
    expect(OPS_LEDE_HOST).toContain("hx-fortress ui user");
    // Never bare "session management": on a console whose primary noun is the HX
    // session, that advertises a capability the product does not ship.
    expect(OPS_LEDE_HOST).not.toContain("session management");
  });

  test("the container arm drops the two families a container hides", () => {
    expect(OPS_LEDE_CONTAINER).not.toContain("service, update");
    expect(OPS_LEDE_CONTAINER).toContain("service and update are owned by your orchestrator");
    expect(OPS_LEDE_CONTAINER).toContain("console sign-in sessions");
    expect(opsLede(true)).toBe(OPS_LEDE_CONTAINER);
    expect(opsLede(false)).toBe(OPS_LEDE_HOST);
  });

  test("the false parity claim is gone", () => {
    for (const { rel, text } of CODE) {
      expect(`${rel}:${text.includes("complete command surface")}`).toBe(`${rel}:false`);
    }
    expect(COMMAND_SURFACE_NOTE).toContain("hx-fortress help");
    expect(COMMAND_SURFACE_NOTE).toContain("no terminal equivalent");
  });
});

describe("the Command Line panel is the help registry", () => {
  test("it renders the registry rather than a list of its own", () => {
    const ops = (FILES.find((f) => f.rel.endsWith("views/Ops.tsx")) as { text: string }).text;
    expect(ops).toContain("helpEntries()");
    // Not one verb is spelled out in the view: the panel that had its own list
    // went stale within a release, because nothing fails when a page forgets a
    // verb.
    const spelled = helpEntries()
      // The bare binary name is a substring of every mention of it, so it is
      // not evidence of a spelled-out list.
      .filter((entry) => entry.usage !== "hx-fortress" && ops.includes(entry.usage));
    expect(spelled).toEqual([]);
  });

  test("every verb the terminal prints reaches the panel", () => {
    const printed = renderHelp().join("\n");
    for (const entry of helpEntries()) {
      expect(`${entry.usage}: ${printed.includes(entry.usage)}`).toBe(`${entry.usage}: true`);
    }
    expect(helpEntries().length).toBe(CLI_HELP.reduce((n, s) => n + s.entries.length, 0));
  });
});

// ── the router, and the fragment exception ───────────────────────────────────

describe("the router", () => {
  test("every nav view round-trips through its path", () => {
    for (const view of NAV_VIEWS) {
      const route = { ...parsePath("/"), view };
      expect(parsePath(formatPath(route)).view).toBe(view);
    }
  });

  test("an unknown path is the overview, and a deep link is itself", () => {
    expect(parsePath("/nothing-here").view).toBe("overview");
    expect(parsePath("/sessions/claude-cli/59e3ccf5")).toMatchObject({
      view: "session-detail",
      family: "claude-cli",
      sid: "59e3ccf5",
    });
    expect(parsePath("/sessions/search/routing+gates").query).toBe("routing gates");
    expect(parsePath("/people/erik")).toMatchObject({ view: "person-detail", personId: "erik" });
    expect(parsePath("/logs/session_vault/errors")).toMatchObject({
      logModule: "session_vault",
      logLevel: "error",
    });
  });

  test("the three fragment-carried tokens, and nothing else", () => {
    expect(peekFragmentToken("t", "#t=abc")).toBe("abc");
    expect(peekFragmentToken("e", "#e=xyz")).toBe("xyz");
    expect(peekFragmentToken("g", "#g=grant")).toBe("grant");
    // A fragment for one key is never read as another's, and an empty one is no
    // token at all.
    expect(peekFragmentToken("t", "#e=xyz")).toBeNull();
    expect(peekFragmentToken("t", "#t=")).toBeNull();
    expect(peekFragmentToken("t", "")).toBeNull();
  });

  test("the setup link the CLI prints lands on the setup screen", () => {
    const url = new URL(setupUrl("https://fortress.example", "tok-123"));
    expect(parsePath(url.pathname).view).toBe("setup");
    expect(peekFragmentToken("t", url.hash)).toBe("tok-123");
    // The token is in the fragment, so it never reaches the server on the
    // navigation itself.
    expect(url.search).toBe("");
    expect(url.pathname).not.toContain("tok-123");
  });

  test("the bootstrap path is served by the index handler, not a route of its own", () => {
    expect(BOOTSTRAP_PATH).toBe("/sso/bootstrap");
    expect(parsePath(BOOTSTRAP_PATH).view).toBe("sso-bootstrap");
    const registry = new RouteRegistry();
    const match = registry.lookup("GET", BOOTSTRAP_PATH);
    expect(match?.path).toBe("/");
    expect(match?.cls).toBe("public");
    // The public enumeration is unchanged: no new server route was added for it.
    expect(PUBLIC_ROUTES.some((r) => r.path === BOOTSTRAP_PATH)).toBe(false);
  });
});

describe("role-aware controls", () => {
  test("a mutation control states the server's own refusal", () => {
    const components = (FILES.find((f) => f.rel.endsWith("ui/src/components.tsx")) as {
      text: string;
    }).text;
    expect(components).toContain("READONLY_REFUSAL_COPY");
    // The button is rendered and disabled, never hidden: hiding it leaves an
    // auditor unable to tell a capability they lack from one that does not exist.
    expect(components).toContain("disabled={blocked}");
    expect(READONLY_REFUSAL_COPY).toContain("read-only");
  });
});

describe("what the SPA reaches into the server tree", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "..");

  /** Every `../../src/...` specifier under ui/src, resolved to a file path. */
  function serverModulesTheSpaImports(): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        for (const m of readFileSync(full, "utf8").matchAll(/from "(\.\.\/)+src\/([^"]+)"/g)) {
          found.add(`src/${m[2]}`);
        }
      }
    };
    walk(path.join(root, "ui", "src"));
    return [...found].sort();
  }

  /** Follow local relative imports from a server module, breadth-first. */
  function reachableFrom(entries: string[]): Map<string, string> {
    const seen = new Map<string, string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const spec = queue.shift()!;
      if (seen.has(spec)) continue;
      const file = [".ts", ".tsx", "/index.ts"]
        .map((ext) => path.join(root, spec + ext))
        .find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
      if (!file) continue;
      const source = readFileSync(file, "utf8");
      seen.set(spec, source);
      for (const m of source.matchAll(/from "(\.[^"]*)"/g)) {
        queue.push(path.normalize(path.join(path.dirname(spec), m[1]!)));
      }
    }
    return seen;
  }

  test("nothing it reaches pulls a node: builtin behind it", () => {
    // The SPA bundles the whole graph behind every specifier it names, so a
    // constant shared with the server has to live in a module that reaches no
    // Node builtin. This went red once: deduplicating the session header made
    // ui/src import sessions.ts, which imports node:crypto, and the console
    // build failed with "createHash is not exported by __vite-browser-external".
    // The build catches that only when a builtin lands in retained code; this
    // catches the import the moment it appears.
    const offenders: string[] = [];
    for (const [spec, source] of reachableFrom(serverModulesTheSpaImports())) {
      const builtins = [...source.matchAll(/from "(node:[^"]+)"/g)].map((m) => m[1]);
      if (builtins.length > 0) offenders.push(`${spec} -> ${[...new Set(builtins)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
