// The browser's side of HX Fortress's setup.
//
// The link's token is exchanged once for a session, and the session is kept in
// this tab's sessionStorage: a reload goes on, and another tab, another browser
// or a copied address has nothing. No cookie is involved, so nothing another
// site does can ride on it.
//
// A key a person types in the install goes to the host in one request of its
// own (`typed`) and nowhere else: never into the answers, never into storage,
// never into a log line.

import type { SetupAnswers } from "../../../../src/setup/answers";
import type { StepId } from "../../../../src/setup/list";
import type { Progress, SetupDerived, SetupDone, SetupState, StepCheck } from "../../../../src/setup/view";
import { FORTRESS_SETUP_API, SETUP_SESSION_HEADER } from "../../../../src/ui/wire";

const STORAGE_KEY = "hx-fortress-setup";

/** What the page says of a setup that is over, when the host gave no sentence of its own. */
export const SETUP_CLOSED = "Setup is closed. To change an answer, run `hx-fortress setup` on the host";

/** What the page says when the host did not answer at all. */
export const NO_ANSWER = "The setup on the host does not answer";

/** What the page says when it was opened without the link, in a tab that has
 *  no session. */
export const NO_LINK = "This page opens from the setup link that the host printed";

export function readSetupSession(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSetupSession(session: string | null): void {
  try {
    if (session === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, session);
  } catch {
    // A browser with no session storage still works until the tab is reloaded.
  }
}

/** The setup does not answer this tab, and will not: the link was used, the
 *  setup ended, or this is the console and not the setup. `message` is the
 *  server's sentence when it wrote one. */
export class SetupClosed extends Error {}

/** The setup is still open and this tab's session is still good, but this
 *  request got no answer now: the host is busy with the answers (409), asks for
 *  fewer requests (429), failed (5xx), or did not answer at all (status 0). */
export class SetupNotNow extends Error {
  readonly status: number;
  /** Seconds to wait before asking again, when the host said. */
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** The statuses that mean the setup will not answer this tab again: a wrong
 *  Host or Origin, no valid session, no setup at this address, or a setup that
 *  has ended. Every other failure is a "not now". */
const CLOSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 410]);

function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

let held: string | null = null;

// The session is read before the first await, so a call that has been made
// keeps it even when the session is forgotten right after.
async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const session = held ?? readSetupSession();
  let response: Response;
  try {
    response = await fetch(`${FORTRESS_SETUP_API}/${route}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(session ? { [SETUP_SESSION_HEADER]: session } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new SetupNotNow(NO_ANSWER, 0, null);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const said = (parsed as { error?: unknown } | null)?.error;
  if (CLOSED_STATUSES.has(response.status)) {
    // After the setup ends the console answers at the same address, and its
    // own "not found" says nothing about the setup.
    throw new SetupClosed(typeof said === "string" && response.status !== 404 ? said : SETUP_CLOSED);
  }
  if (!response.ok) {
    throw new SetupNotNow(typeof said === "string" ? said : NO_ANSWER, response.status, retryAfterOf(response));
  }
  // An answer the page cannot read is no answer.
  if (parsed === null || typeof parsed !== "object") throw new SetupNotNow(NO_ANSWER, response.status, null);
  return parsed as T;
}

/** One step's check. */
export interface StepCheckAnswer {
  derived: SetupDerived;
  check: StepCheck | null;
}

/** Every step's check. */
export interface AllChecksAnswer {
  derived: SetupDerived;
  checks: StepCheck[];
}

/** What the last step's yes answers: it started, or an answer is refused. */
/** The start of the last step: how far it is already, and what it made when
 *  it is done by the time it answers, as a setup on the machine itself is. */
export type CreateAnswer = { progress: Progress; done?: SetupDone | null } | AllChecksAnswer;

/** How far the last step is, and what the last screen shows once it is done. */
export interface ProgressAnswer {
  progress: Progress;
  done: SetupDone | null;
}

export const setupApi = {
  /** Exchange the link's token for this tab's session. Works once. */
  async open(token: string): Promise<void> {
    const answer = await call<{ session: string }>("POST", "open", { token });
    held = answer.session;
    writeSetupSession(answer.session);
  },
  state: (): Promise<SetupState> => call("GET", "state"),
  /** One step's check. `quick` asks nothing outside this computer: it is what
   *  the page sends while a person types. */
  check: (answers: SetupAnswers, step: StepId, quick = false): Promise<StepCheckAnswer> =>
    call("POST", "check", quick ? { answers, step, quick: true } : { answers, step }),
  /** Every step's check. */
  checkAll: (answers: SetupAnswers): Promise<AllChecksAnswer> => call("POST", "check", { answers }),
  /** A key a person typed, for the field at `path`. Only the install takes one.
   *  The reply names the fields that hold a typed key, and never a key. */
  typed: (path: string, value: string): Promise<{ typed: string[]; refused?: string }> =>
    call("POST", "typed", { path, value }),
  /** The last step's yes. */
  create: (answers: SetupAnswers): Promise<CreateAnswer> => call("POST", "create", { answers }),
  progress: (): Promise<ProgressAnswer> => call("GET", "progress"),
  /** Tell the host the last screen arrived, so it stops listening now. */
  seen: (): Promise<unknown> => call("POST", "seen", {}),
  /** Forget the session. The setup is over for this tab. */
  forget(): void {
    held = null;
    writeSetupSession(null);
  },
};
