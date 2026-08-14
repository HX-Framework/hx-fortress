import React, { useEffect, useMemo, useRef, useState } from "react";

import { API, api, downloadFromServer } from "../api";
import { Empty, FactRow, Loaded, MenuPill, Panel, ResultLine, SearchBox, useResultLine } from "../components";
import { useResource } from "../hooks";
import { copyText, saveRenderedRows } from "../lib/util";
import { useApp, type LogLine, useLogLines } from "../state";

const LEVELS = [
  { key: "all", label: "Everything" },
  { key: "warn", label: "Warnings & errors" },
  { key: "error", label: "Errors only" },
];

export default function Logs(): React.ReactElement {
  const app = useApp();
  const { logLines, clearLogLines } = useLogLines();
  const active = app.view === "logs";
  const identity = useResource(() => api.identity(), [], { active });
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const [result, showResult] = useResultLine();
  const paneRef = useRef<HTMLDivElement>(null);

  const module = app.route.logModule;
  const level = app.route.logLevel;

  // Modules are whatever the fortress has actually emitted in this buffer. A
  // fixed list would offer filters for modules this build does not have and hide
  // one it grew.
  const modules = useMemo(() => {
    const names = new Set<string>();
    for (const line of logLines) if (line.module) names.add(line.module);
    return [...names].sort();
  }, [logLines]);

  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return logLines.filter((line) => {
      if (module !== "all" && line.module !== module) return false;
      if (level === "warn" && line.level !== "warn" && line.level !== "error") return false;
      if (level === "error" && line.level !== "error") return false;
      if (needle && !line.line.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [logLines, module, level, text]);

  useEffect(() => {
    if (follow && paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [shown, follow]);

  const rendered = (): string => shown.map((line) => line.line).join("\n");

  const exportRange = async (): Promise<void> => {
    const query = new URLSearchParams({ lines: "20000" });
    if (module !== "all") query.set("module", module);
    if (level !== "all") query.set("level", level);
    try {
      await downloadFromServer(`${API.logsExport}?${query.toString()}`, "hx-fortress-logs.jsonl");
      showResult("The fortress read the log, applied these filters, and recorded that a copy left.");
    } catch (err) {
      showResult(err instanceof Error ? err.message : "the export was refused", true);
    }
  };

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">System</div>
      <h1>Fortress logs</h1>
      <p className="lede">
        The daemon's own structured records, followed live over this console's single connection —
        across rotations, so the view does not go silent the moment the file turns over.
      </p>

      <div className="logtitle">
        {app.live.kind === "live"
          ? "Following the daemon log"
          : app.live.kind === "connecting"
            ? "Opening the live connection…"
            : `Reconnecting — ${app.live.reason}`}
      </div>
      <div className="logbar oneline">
        <div className="lgroup">
          <span className="llbl">Module</span>
          <MenuPill
            mini
            value={module === "all" ? "All" : module}
            selKey={module}
            items={[{ key: "all", label: "All modules" }, ...modules.map((m) => ({ key: m, label: m }))]}
            onPick={(key) => app.navigate({ logModule: key })}
          />
        </div>
        <div className="lgroup">
          <span className="llbl">Level</span>
          <MenuPill
            mini
            value={LEVELS.find((l) => l.key === level)?.label ?? "Everything"}
            selKey={level}
            items={LEVELS}
            onPick={(key) => app.navigate({ logLevel: key })}
          />
        </div>
        <SearchBox
          compact
          placeholder="Search the lines on screen…"
          value={text}
          onInput={setText}
          style={{ flex: "1 1 200px", minWidth: 160 }}
        />
        <button className={follow ? "fpill sel" : "fpill"} onClick={() => setFollow((f) => !f)}>
          {follow ? "Following" : "Paused"}
        </button>
        <button className="btn ghost sm" onClick={(e) => copyText(rendered(), e.currentTarget)}>
          Copy
        </button>
        <button
          className="btn ghost sm"
          onClick={() => saveRenderedRows(rendered(), "fortress-logs-on-screen.txt")}
        >
          Save what is on screen
        </button>
        <button className="btn sm" onClick={() => void exportRange()}>
          Export
        </button>
      </div>

      <div
        className="logpane scrolly"
        ref={paneRef}
        onScroll={() => {
          const pane = paneRef.current;
          if (!pane) return;
          if (follow && pane.scrollHeight - pane.scrollTop - pane.clientHeight > 80) setFollow(false);
        }}
      >
        {shown.length === 0 ? (
          <div className="ln" style={{ color: "var(--text-subtle)" }}>
            {logLines.length === 0
              ? "Nothing has arrived on the live connection yet."
              : "No line on screen matches this filter."}
          </div>
        ) : (
          shown.map((line, i) => <Line key={`${line.ts ?? ""}-${i}`} line={line} />)
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginTop: 10,
          fontSize: 14.5,
          color: "var(--text-subtle)",
        }}
      >
        <span>
          {shown.length} of {logLines.length} lines on screen
        </span>
        <span>scroll up to pause following</span>
      </div>
      <ResultLine state={result} />

      <Panel
        title="Copying, saving and exporting"
        sub="Three different things, and only one of them is recorded."
        className=""
      >
        <div className="facts wide">
          <FactRow
            k="Copy · Save"
            v="Not an export"
            vs="both re-save the lines already delivered to this tab and already on screen. Nothing new leaves the fortress, and nothing is recorded."
          />
          <FactRow
            k="Export"
            v="Recorded"
            vs="the fortress reads the log itself, applies the module and level above server-side, and writes an audit record naming the parameters it ran under."
          />
        </div>
      </Panel>

      <Panel title="Files on this host" sub="Resolved from this install's own root, never from a path written into a page.">
        <Loaded resource={identity}>
          {(data) => (
            <div className="facts wide">
              <FactRow k="Structured log" v={<span className="mono">{data.paths.log}</span>} vs={data.retention.logs} />
              <FactRow k="Service output" v={<span className="mono">{data.paths.serviceLog}</span>} />
              <FactRow k="Status snapshot" v={<span className="mono">{data.paths.status}</span>} />
              <FactRow k="Runtime" v={<span className="mono">{data.paths.runtime}</span>} />
            </div>
          )}
        </Loaded>
      </Panel>
    </section>
  );
}

function Line({ line }: { line: LogLine }): React.ReactElement {
  const className = `ln${line.level === "error" ? " errl" : line.level === "warn" ? " warnl" : ""}`;
  if (!line.ts && !line.message) {
    // A line that did not parse is shown as it arrived: a torn write or a stray
    // stdout line is exactly what somebody reading the log at 3am needs to see.
    return <div className={className}>{line.line}</div>;
  }
  return (
    <div className={className}>
      <span className="lt">{line.ts ? line.ts.slice(11, 19) : "--:--:--"}</span>{" "}
      <span className="lm">{line.module ?? "-"}</span> {line.message ?? ""}
      {Object.entries(line.fields).map(([key, value]) => (
        <span key={key}>
          {" "}
          <span className="lk">{key}=</span>
          <span className="lv">{typeof value === "string" ? value : JSON.stringify(value)}</span>
        </span>
      ))}
    </div>
  );
}
