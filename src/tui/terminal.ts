import type { TuiApp } from "./app";
import type { DetailsScreenAction, MainScreenAction, MainScreenRow } from "./types";

const CSI = "[";
const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
const CLEAR_REMAINDER = `${CSI}J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const RESET = `${CSI}0m`;
const INVERT = `${CSI}7m`;
const DIM = `${CSI}2m`;

type TerminalInput = NodeJS.ReadStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type TerminalOutput = NodeJS.WriteStream & {
  isTTY?: boolean;
};

export interface RunTerminalRendererOptions {
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
}

export async function runTerminalRenderer(
  app: TuiApp,
  options: RunTerminalRendererOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  assertInteractiveTerminal(stdin, stdout);

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let pending = Promise.resolve();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("error", onError);
      stdin.pause();
      stdin.setRawMode?.(false);
      stdout.write(`${RESET}${SHOW_CURSOR}`);
    };

    const finish = (code: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(code);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const onData = (chunk: Buffer | string): void => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      pending = pending
        .then(async () => {
          const shouldExit = await handleTerminalKey(app, key);
          if (shouldExit) {
            finish(0);
            return;
          }

          if (!settled) {
            render(app, stdout);
          }
        })
        .catch((error) => fail(error));
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onError);
    render(app, stdout);
  });
}

export async function handleTerminalKey(
  app: TuiApp,
  key: string,
): Promise<boolean> {
  switch (key) {
    case "q":
    case "Q":
    case "":
      return true;
    case "\r":
    case "\n":
      await app.activate();
      return false;
    case "":
    case "b":
    case "B":
      app.goBack();
      return false;
    case "[A":
    case "OA":
      app.moveRow(-1);
      return false;
    case "[B":
    case "OB":
      app.moveRow(1);
      return false;
    case "[D":
    case "OD":
      app.moveAction(-1);
      return false;
    case "[C":
    case "OC":
      app.moveAction(1);
      return false;
    default:
      return false;
  }
}

function render(app: TuiApp, stdout: TerminalOutput): void {
  const state = app.state();

  switch (state.screen) {
    case "main":
      renderMain(app, stdout);
      return;
    case "details":
      renderDetails(app, stdout);
      return;
    case "confirm-uninstall":
      renderConfirmUninstall(app, stdout);
      return;
  }
}

function renderMain(app: TuiApp, stdout: TerminalOutput): void {
  const model = app.model();
  const state = app.state();
  const lines: string[] = [
    `${HIDE_CURSOR}${CLEAR_SCREEN}HX Fortress`,
    "",
    ...model.rows.flatMap((row, rowIndex) => renderMainRow(row, rowIndex, state)),
  ];

  if (state.error) {
    lines.push("");
    lines.push(`error: ${state.error}`);
  }
  if (state.notice) {
    lines.push("");
    for (const line of state.notice) lines.push(line);
  }

  lines.push("");
  lines.push(model.footerNote);
  lines.push(`${DIM}Use arrows to move, Enter to activate, q to quit.${RESET}`);
  stdout.write(`${lines.join("\n")}${CLEAR_REMAINDER}`);
}

function renderDetails(app: TuiApp, stdout: TerminalOutput): void {
  const details = app.detailsModel();
  const state = app.state();

  if (!details) {
    stdout.write(`${HIDE_CURSOR}${CLEAR_SCREEN}HX Fortress — Details${CLEAR_REMAINDER}`);
    return;
  }

  const installed = details.installedVersion ?? "—";
  const available = details.availableVersion ?? "—";

  const lines: string[] = [
    `${HIDE_CURSOR}${CLEAR_SCREEN}HX Fortress — ${details.label}`,
    "",
    `  installed: ${installed}`,
    `  available: ${available}`,
    "",
    `  ${details.actions
      .map((action, index) => renderDetailsAction(action, index === state.selectedAction))
      .join("  ")}`,
  ];

  if (state.error) {
    lines.push("");
    lines.push(`  error: ${state.error}`);
  }

  lines.push("");
  lines.push(`${DIM}Use left/right to select action, Enter to activate, Esc or b to go back, q to quit.${RESET}`);
  stdout.write(`${lines.join("\n")}${CLEAR_REMAINDER}`);
}

function renderConfirmUninstall(app: TuiApp, stdout: TerminalOutput): void {
  const details = app.detailsModel();
  const state = app.state();
  const label = details?.label ?? "component";

  const lines: string[] = [
    `${HIDE_CURSOR}${CLEAR_SCREEN}HX Fortress — Uninstall ${label}`,
    "",
    `  This will remove ${label} from Fortress. This cannot be undone.`,
    "",
    `  ${renderConfirmButton("Confirm", state.selectedAction === 0)}  ${renderConfirmButton("Cancel", state.selectedAction === 1)}`,
  ];

  if (state.error) {
    lines.push("");
    lines.push(`  error: ${state.error}`);
  }

  lines.push("");
  lines.push(`${DIM}Use left/right to select, Enter to activate, Esc or b to cancel.${RESET}`);
  stdout.write(`${lines.join("\n")}${CLEAR_REMAINDER}`);
}

function renderMainRow(
  row: MainScreenRow,
  rowIndex: number,
  state: ReturnType<TuiApp["state"]>,
): string[] {
  const selected = rowIndex === state.selectedRow;
  const prefix = selected ? ">" : " ";
  const installed = row.installedVersion ?? "-";
  const available = row.availableVersion ?? "-";

  return [
    `${prefix} ${row.label}  status:${row.statusLabel}  installed:${installed}  available:${available}`,
    `  ${row.actions
      .map((action, actionIndex) =>
        renderMainAction(action, selected && actionIndex === state.selectedAction),
      )
      .join("  ")}`,
  ];
}

function renderMainAction(action: MainScreenAction, selected: boolean): string {
  const label = mainActionLabel(action);
  const text = action.enabled ? label : `${label} (disabled)`;

  if (!selected) {
    return `[${text}]`;
  }

  return `${INVERT}[${text}]${RESET}`;
}

function mainActionLabel(action: MainScreenAction): string {
  switch (action.kind) {
    case "start":
      return "start";
    case "stop":
      return "stop";
    case "update":
      return `update ${action.version}`;
    case "view-details":
      return "details";
  }
}

function renderDetailsAction(action: DetailsScreenAction, selected: boolean): string {
  const label = detailsActionLabel(action);

  if (!action.enabled) {
    return `${DIM}[${label}]${RESET}`;
  }

  if (!selected) {
    return `[${label}]`;
  }

  return `${INVERT}[${label}]${RESET}`;
}

function detailsActionLabel(action: DetailsScreenAction): string {
  switch (action.kind) {
    case "update":
      return `update to v${action.version}`;
    case "uninstall":
      return action.reason !== null ? `uninstall (${action.reason})` : "uninstall";
    case "back":
      return "back";
  }
}

function renderConfirmButton(label: string, selected: boolean): string {
  if (!selected) {
    return `[${label}]`;
  }

  return `${INVERT}[${label}]${RESET}`;
}

function assertInteractiveTerminal(
  stdin: TerminalInput,
  stdout: TerminalOutput,
): void {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(
      "hx-fortress tui requires an interactive terminal with TTY stdin/stdout.",
    );
  }
}
