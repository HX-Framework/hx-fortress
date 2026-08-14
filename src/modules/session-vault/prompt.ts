// Minimal interactive prompt kit for the Session Vault enroll wizard.
// Drives /dev/tty through low-level fd reads/writes because Bun's tty stream
// wrappers can throw ENXIO when reading a manually-opened terminal.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

const ESC = "\x1b";

export interface PromptIo {
  close: () => void;
  readChar: () => string;
  setRawMode: (enabled: boolean) => void;
  write: (chunk: string) => void;
}

/** True when /dev/tty is accessible — the wizard only prompts when this holds. */
export function ttyAvailable(): boolean {
  return spawnSync("sh", ["-c", "(: </dev/tty) 2>/dev/null"]).status === 0;
}

function sttyDeviceFlag(): "-f" | "-F" {
  return process.platform === "darwin" || process.platform.endsWith("bsd") ? "-f" : "-F";
}

function runStty(args: string[]): string {
  const result = spawnSync("stty", [sttyDeviceFlag(), "/dev/tty", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `stty ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function openPromptIo(): PromptIo {
  const fd = openSync("/dev/tty", "r+");
  let restoreState: string | null = null;

  return {
    close: () => {
      try {
        if (restoreState !== null) {
          runStty([restoreState]);
          restoreState = null;
        }
      } finally {
        closeSync(fd);
      }
    },
    readChar: () => {
      const buf = Buffer.alloc(1);
      const bytes = readSync(fd, buf, 0, 1, null);
      if (bytes <= 0) {
        throw new Error("Failed to read from /dev/tty");
      }
      return buf.toString("utf8", 0, bytes);
    },
    setRawMode: (enabled: boolean) => {
      if (enabled) {
        if (restoreState !== null) return;
        restoreState = runStty(["-g"]).trim();
        runStty(["raw", "-echo"]);
        return;
      }
      if (restoreState === null) return;
      runStty([restoreState]);
      restoreState = null;
    },
    write: (chunk: string) => {
      writeSync(fd, Buffer.from(chunk));
    },
  };
}

function readEscapeSequence(io: PromptIo): string {
  const next = io.readChar();
  if (next !== "[" && next !== "O") return ESC + next;
  return ESC + next + io.readChar();
}

/** Free-text input with an optional default (Enter accepts the default). */
export function textPrompt(message: string, opts: { default?: string } = {}): Promise<string> {
  return runTextPrompt(message, opts, openPromptIo());
}

export async function runTextPrompt(
  message: string,
  opts: { default?: string } = {},
  io: PromptIo,
): Promise<string> {
  const suffix = opts.default ? ` [${opts.default}]` : "";
  let buf = "";

  io.write(`${message}${suffix} `);
  io.setRawMode(true);
  try {
    while (true) {
      const ch = io.readChar();
      if (ch === "\r" || ch === "\n") {
        io.write("\r\n");
        return buf.trim() || opts.default || "";
      }
      if (ch === "\x03") {
        io.write("\r\n");
        process.exit(130);
      }
      if (ch === "\x7f" || ch === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          io.write("\b \b");
        }
        continue;
      }
      if (ch >= " " && ch !== "\x7f") {
        buf += ch;
        io.write(ch);
      }
    }
  } finally {
    io.close();
  }
}

/** Yes/no with a default selected by Enter. */
export async function confirmPrompt(
  message: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  const def = opts.default ?? true;
  const ans = (await textPrompt(`${message} ${def ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  if (!ans) return def;
  return ans.startsWith("y");
}

/** Masked input for secrets — each character echoes as a '*' (MC-2464). */
export async function passwordPrompt(message: string): Promise<string> {
  const io = openPromptIo();
  let buf = "";

  io.write(`${message} `);
  io.setRawMode(true);
  try {
    while (true) {
      const ch = io.readChar();
      if (ch === "\r" || ch === "\n") {
        io.write("\r\n");
        return buf;
      }
      if (ch === "\x03") {
        io.write("\r\n");
        process.exit(130);
      }
      if (ch === "\x7f" || ch === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          io.write("\b \b");
        }
        continue;
      }
      if (ch >= " " && ch !== "\x7f") {
        buf += ch;
        io.write("*");
      }
    }
  } finally {
    io.close();
  }
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Arrow-key select with optional type-to-filter and 1-9 number shortcuts.
 *  In non-filter mode pressing a digit immediately picks that option.
 *  Returns the chosen value. */
export async function selectPrompt<T>(
  message: string,
  choices: Choice<T>[],
  opts: { filter?: boolean; defaultIndex?: number } = {},
): Promise<T> {
  return runSelectPrompt(message, choices, opts, openPromptIo());
}

export async function runSelectPrompt<T>(
  message: string,
  choices: Choice<T>[],
  opts: { filter?: boolean; defaultIndex?: number } = {},
  io: PromptIo,
): Promise<T> {
  let filter = "";
  let index = opts.defaultIndex ?? 0;
  let lastLines = 0;

  const visible = (): Choice<T>[] =>
    opts.filter && filter
      ? choices.filter((c) => c.label.toLowerCase().includes(filter.toLowerCase()))
      : choices;

  const render = (): void => {
    if (lastLines > 0) {
      io.write(`${ESC}[${lastLines}A\r`);
      io.write(`${ESC}[0J`);
    } else {
      io.write(`\r\n${ESC}[0J`);
    }
    const list = visible();
    if (index >= list.length) index = Math.max(0, list.length - 1);
    const out: string[] = [
      `${message}${opts.filter ? (filter ? `  (filter: ${filter})` : "  (type to filter)") : ""}`,
    ];
    if (list.length === 0) out.push("  (no matches)");
    list.forEach((c, i) => {
      const prefix = i === index ? "❯ " : "  ";
      out.push(`${prefix}${i + 1}) ${c.label}${c.hint ? `  ${c.hint}` : ""}`);
    });
    io.write(`${out.join("\r\n")}\r\n`);
    lastLines = out.length;
  };

  io.setRawMode(true);
  try {
    render();
    while (true) {
      const ch = io.readChar();
      const s = ch === ESC ? readEscapeSequence(io) : ch;
      const list = visible();
      const n = Math.max(1, list.length);

      if (s === `${ESC}[A` || s === `${ESC}OA`) {
        index = (index - 1 + n) % n;
        render();
        continue;
      }
      if (s === `${ESC}[B` || s === `${ESC}OB`) {
        index = (index + 1) % n;
        render();
        continue;
      }
      if (s === "\r" || s === "\n") {
        const choice = list[index];
        if (choice) {
          io.write("\r\n");
          return choice.value;
        }
        continue;
      }
      if (s === "\x03") {
        io.write("\r\n");
        process.exit(130);
      }
      if (!opts.filter && s >= "1" && s <= "9") {
        const pick = list[Number(s) - 1];
        if (pick) {
          io.write("\r\n");
          return pick.value;
        }
      }
      if (opts.filter) {
        if (s === "\x7f" || s === "\b") {
          filter = filter.slice(0, -1);
          index = 0;
          render();
        } else if (s >= " " && s.length === 1) {
          filter += s;
          index = 0;
          render();
        }
      }
    }
  } finally {
    io.close();
  }
}
