import React from "react";

import type { Picture } from "../../../../src/setup/picture";
import { NEW_VERSIONS_FROM } from "../../../../src/setup/reach";

// The picture beside each page of the setup: what is being set up.
//
// Clouds are on top and a person's browser is at the bottom. A dark box is
// HX Fortress. A white box is something of the organization's. A tinted box is
// the control plane. A dashed box is one the organization already runs.
//
// Every word in it comes from `pictureOf` or from the list: the picture holds
// none of its own. Each part that can come and go has a `data-k`, so the page
// fades in a part that is new.

/** How wide a line of text is, roughly, in pixels. Close enough to decide
 *  between two sizes, or where a line breaks. */
function widthOf(text: string, px: number, mono = false): number {
  if (mono) return text.length * px * 0.6;
  let em = 0;
  for (const ch of text) {
    if ("ilj.,:;|!'I".includes(ch)) em += 0.27;
    else if (ch === " ") em += 0.28;
    else if ("ftr".includes(ch)) em += 0.36;
    else if (ch === "-" || ch === "_") em += 0.4;
    else if (ch === "m") em += 0.86;
    else if (ch === "w") em += 0.76;
    else if (ch === "M") em += 0.85;
    else if (ch === "W") em += 0.95;
    else if (ch >= "A" && ch <= "Z") em += 0.66;
    else if (ch >= "0" && ch <= "9") em += 0.6;
    else em += 0.55;
  }
  return em * px * 1.04;
}

/** The text, shortened with an ellipsis until it fits. */
function fit(text: string, max: number, px: number, mono = false): string {
  if (widthOf(text, px, mono) <= max) return text;
  let cut = text;
  while (cut.length > 1 && widthOf(`${cut}…`, px, mono) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** A caption in one line, or in two where one is too wide. */
function captionLines(caption: string, max: number): { lines: string[]; small: boolean } {
  if (widthOf(caption, 11.5) <= max) return { lines: [caption], small: false };
  if (widthOf(caption, 10.5) <= max) return { lines: [caption], small: true };
  const comma = caption.indexOf(", ");
  if (comma > 0) {
    return { lines: [caption.slice(0, comma + 1), fit(caption.slice(comma + 2), max, 10.5)], small: true };
  }
  const words = caption.split(" ");
  let first = words[0] ?? "";
  let i = 1;
  while (i < words.length && widthOf(`${first} ${words[i]}`, 10.5) <= max) {
    first = `${first} ${words[i]}`;
    i += 1;
  }
  return { lines: [first, fit(words.slice(i).join(" "), max, 10.5)], small: true };
}

/** The two short lines of a box, set to fit its width: in the regular size,
 *  a size smaller, or with the longer line broken in two. */
function boxLines(lines: readonly string[], max: number): { lines: string[]; small: boolean } {
  if (lines.every((line) => widthOf(line, 12.5) <= max)) return { lines: [...lines], small: false };
  if (lines.every((line) => widthOf(line, 11.5) <= max)) return { lines: [...lines], small: true };
  const out: string[] = [];
  for (const line of lines) {
    if (widthOf(line, 11.5) <= max) {
      out.push(line);
      continue;
    }
    const words = line.split(" ");
    let first = words[0] ?? "";
    let i = 1;
    while (i < words.length - 1 && widthOf(`${first} ${words[i]}`, 11.5) <= max) {
      first = `${first} ${words[i]}`;
      i += 1;
    }
    out.push(first, fit(words.slice(i).join(" "), max, 11.5));
  }
  return { lines: out.slice(0, 3).map((line) => fit(line, max, 11.5)), small: true };
}

/** The lines of a box under its caption, centred on `mid`. */
function BoxLines({ lines, x, mid }: { lines: readonly string[]; x: number; mid: number }): React.ReactElement {
  const set = boxLines(lines.filter(Boolean), 82);
  const step = set.small ? 15 : 16;
  const first = mid - ((set.lines.length - 1) * step) / 2;
  return (
    <>
      {set.lines.map((line, i) => (
        <Text key={i} x={x} y={first + i * step} cls={set.small ? "sp-t2" : "sp-t"}>
          {line}
        </Text>
      ))}
    </>
  );
}

function Arrow({ x1, y1, x2, y2, cls = "" }: { x1: number; y1: number; x2: number; y2: number; cls?: string }): React.ReactElement {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = 8;
  const W = 4.2;
  const bx = x2 - L * Math.cos(a);
  const by = y2 - L * Math.sin(a);
  const p = [x2, y2, bx + W * Math.sin(a), by - W * Math.cos(a), bx - W * Math.sin(a), by + W * Math.cos(a)].map((n) =>
    n.toFixed(1),
  );
  return (
    <g className={`sp-g ${cls}`}>
      <line className="sp-l" x1={x1} y1={y1} x2={bx.toFixed(1)} y2={by.toFixed(1)} />
      <polygon className="sp-a" points={`${p[0]},${p[1]} ${p[2]},${p[3]} ${p[4]},${p[5]}`} />
    </g>
  );
}

function Box(props: { x: number; y: number; w: number; h: number; cls: string; rx?: number }): React.ReactElement {
  return <rect className={props.cls} x={props.x} y={props.y} width={props.w} height={props.h} rx={props.rx ?? 12} />;
}

function Text(props: {
  x: number;
  y: number;
  cls: string;
  anchor?: "start" | "middle" | "end";
  children: string;
}): React.ReactElement {
  return (
    <text className={props.cls} x={props.x} y={props.y} textAnchor={props.anchor ?? "middle"}>
      {props.children}
    </text>
  );
}

function CloudMark({ dx = 0 }: { dx?: number }): React.ReactElement {
  return (
    <path
      className="sp-cl"
      transform={dx ? `translate(${dx},0)` : undefined}
      d="M10.5 17h7.2a2.8 2.8 0 0 0 .5-5.55 4.1 4.1 0 0 0-7.9-.9A3.25 3.25 0 0 0 10.5 17z"
    />
  );
}

function Face({ cx, cy }: { cx: number; cy: number }): React.ReactElement {
  return (
    <>
      <circle className="sp-av" cx={cx} cy={cy} r={8} />
      <circle className="sp-avg" cx={cx} cy={cy - 2.3} r={2.6} />
      <path className="sp-avg" d={`M${cx - 4.9} ${cy + 5.4}a4.9 4.2 0 0 1 9.8 0z`} />
    </>
  );
}

function WindowTop({ x, y, w }: { x: number; y: number; w: number }): React.ReactElement {
  return (
    <>
      <path className="sp-l sp-rule" d={`M${x} ${y + 24}h${w}`} />
      {[14, 24, 34].map((d) => (
        <circle key={d} className="sp-dot" cx={x + d} cy={y + 12} r={3} />
      ))}
    </>
  );
}

function Padlock({ x, y }: { x: number; y: number }): React.ReactElement {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect className="sp-cl" x={1.5} y={5} width={8} height={6} rx={1.4} />
      <path className="sp-cl" d="M3.3 5V3.6a2.2 2.2 0 0 1 4.4 0V5" />
    </g>
  );
}

/** A ring around the part a page is about. */
function Ring(props: { on: boolean; name: string; x: number; y: number; w: number; h: number; rx?: number }): React.ReactElement | null {
  if (!props.on) return null;
  return (
    <g data-k={`pic-hl-${props.name}`}>
      <rect className="sp-hl" x={props.x - 4} y={props.y - 4} width={props.w + 8} height={props.h + 8} rx={(props.rx ?? 12) + 3} />
    </g>
  );
}

type CallId = Picture["calls"][number]["id"];

/** The outside addresses, top to bottom. Each has its own place, whether it is
 *  drawn or not, so one that comes or goes moves nothing else. */
const CALL_ORDER: readonly CallId[] = ["controlPlane", "model", "signIn", "releases"];

export interface PictureWords {
  /** The captions of the keys box, the database box and the browser's form:
   *  the names of the steps that ask about them. */
  keys: string;
  database: string;
  signIn: string;
}

/**
 * The picture, drawn from what `pictureOf` worked out.
 *
 * `part` is the part the page lights up (`PICTURE_PART`), or null.
 */
export function SetupPicture({
  picture,
  part,
  words,
}: {
  picture: Picture;
  part: string | null;
  words: PictureWords;
}): React.ReactElement {
  const p = picture;
  // In this build a new version arrives through the control plane, so the
  // page about updates lights up the control plane's box.
  const releasesAt: CallId = NEW_VERSIONS_FROM === "control-plane" ? "controlPlane" : "releases";
  const lit = (name: string): boolean => part === name;

  const slots: { id: CallId; y: number; h: number; caption: string[]; small: boolean; name: string }[] = [];
  let y = 30;
  for (const id of CALL_ORDER) {
    const call = p.calls.find((c) => c.id === id);
    const caption = call ? captionLines(call.caption, 110) : { lines: [""], small: false };
    const h = caption.lines.length > 1 ? 58 : 46;
    if (call) slots.push({ id, y, h, caption: caption.lines, small: caption.small, name: call.name });
    y += h + 8;
  }
  const centres = slots.map((s) => s.y + s.h / 2).concat([132]);
  const railTop = Math.min(...centres);
  const railBottom = Math.max(...centres);
  const callsLit = lit("calls");

  const moduleGap = p.modules.length > 4 ? Math.max(21, Math.min(26, 106 / (p.modules.length - 1))) : 26;
  const placeKey = p.band.split(" · ")[0] ?? p.band;
  const describe = [p.band, p.organization, ...p.calls.map((c) => `${c.caption}: ${c.name}`), p.address]
    .filter(Boolean)
    .join(". ");

  return (
    <div className="su-panel">
      <svg className="sp" viewBox="0 0 420 392" role="img" aria-label={describe}>
        {/* The organization's side */}
        <g data-k={`pic-band-${placeKey}`}>
          <Box x={2} y={24} w={250} h={214} cls="sp-net" rx={18} />
          <CloudMark />
          <Text x={28} y={16} cls="sp-ts" anchor="start">
            {fit(p.band, 388, 11.5)}
          </Text>
        </g>
        <Ring on={lit("band")} name="band" x={2} y={24} w={250} h={214} rx={18} />

        <g data-k={`pic-keys-${p.keys.join("-")}`}>
          <Box x={14} y={38} w={90} h={88} cls="sp-b" />
          <Text x={59} y={58} cls="sp-ts">
            {fit(words.keys, 80, 11.5)}
          </Text>
          <BoxLines lines={p.keys} x={59} mid={90} />
        </g>
        <Ring on={lit("keys")} name="keys" x={14} y={38} w={90} h={88} />

        <g data-k={`pic-db-${p.database.join("-")}-${p.databaseIsTheirs ? "theirs" : "made"}`}>
          <Box x={14} y={138} w={90} h={88} cls={p.databaseIsTheirs ? "sp-ghost" : "sp-b"} />
          <Text x={59} y={158} cls="sp-ts">
            {fit(words.database, 80, 11.5)}
          </Text>
          <BoxLines lines={p.database} x={59} mid={190} />
        </g>
        <Ring on={lit("database")} name="database" x={14} y={138} w={90} h={88} />

        <path className="sp-l" d="M104 82h12M104 182h12" />
        <Box x={116} y={38} w={124} h={188} cls="sp-fx" rx={14} />
        <Text x={178} y={62} cls="sp-fxt">
          HX Fortress
        </Text>
        {p.organization ? (
          <Text x={178} y={78} cls="sp-fxm">
            {fit(p.organization, 112, 11)}
          </Text>
        ) : null}
        {p.modules.map((title, i) => (
          <g key={title} data-k={`pic-mod-${title}`}>
            <Box x={121} y={92 + i * moduleGap} w={114} h={20} cls="sp-chd" rx={10} />
            <Text x={178} y={105.5 + i * moduleGap} cls="sp-chdt">
              {fit(title, 106, 10)}
            </Text>
          </g>
        ))}
        <Ring on={lit("hx-fortress")} name="hx-fortress" x={116} y={38} w={124} h={188} rx={14} />

        {/* The addresses it calls: one rail, one branch each */}
        {slots.length > 0 ? (
          <g className={callsLit ? "sp-g acc" : "sp-g"} data-k="pic-rail">
            <path className="sp-l" d={`M240 132h38M278 ${railTop}V${railBottom}`} />
          </g>
        ) : null}
        {slots.map((slot) => {
          const mid = slot.y + slot.h / 2;
          const lineY = slot.caption.length > 1 ? [slot.y + 16, slot.y + 29] : [slot.y + 18];
          const nameY = slot.caption.length > 1 ? slot.y + 47 : slot.y + 35;
          return (
            <g key={slot.id} data-k={`pic-call-${slot.id}`}>
              <Arrow x1={278} y1={mid} x2={296} y2={mid} cls={slot.id === "controlPlane" || callsLit ? "acc" : ""} />
              <Box x={296} y={slot.y} w={120} h={slot.h} cls={slot.id === "controlPlane" ? "sp-cp" : "sp-b"} rx={10} />
              {slot.caption.map((line, i) => (
                <Text key={i} x={356} y={lineY[i] ?? slot.y + 18} cls={slot.small ? "sp-ts2" : "sp-ts"}>
                  {line}
                </Text>
              ))}
              <Text x={356} y={nameY} cls={widthOf(slot.name, 12.5) > 108 ? "sp-t2" : "sp-t"}>
                {fit(slot.name, 110, 11.5)}
              </Text>
            </g>
          );
        })}
        {slots.map((slot) => (
          <Ring
            key={slot.id}
            on={
              (slot.id === "model" && lit("model")) ||
              (slot.id === "signIn" && lit("signIn")) ||
              (slot.id === releasesAt && lit("releases"))
            }
            name={`call-${slot.id}`}
            x={296}
            y={slot.y}
            w={120}
            h={slot.h}
            rx={10}
          />
        ))}
        {p.proxy ? (
          // A gate on the rail: everything it calls goes through one more box.
          <g data-k="pic-proxy">
            <Box x={248} y={122} w={22} h={20} cls="sp-ch" rx={10} />
            <path className="sp-cl" d="M255 128v8M263 128v8" />
          </g>
        ) : null}

        {/* A person's browser */}
        <Box x={4} y={276} w={412} h={112} cls="sp-b" rx={12} />
        <WindowTop x={4} y={276} w={412} />
        {p.lock ? (
          <g data-k="pic-lock">
            <Padlock x={52} y={281} />
          </g>
        ) : null}
        <Text x={p.lock ? 68 : 56} y={292} cls="sp-tm" anchor="start">
          {fit(p.address, p.lock ? 310 : 322, 10.5, true)}
        </Text>
        <Face cx={402} cy={288} />
        <Ring on={lit("browser")} name="browser" x={4} y={276} w={412} h={24} rx={12} />
        <Text x={78} y={346} cls="sp-t">
          {fit(words.signIn, 120, 12.5)}
        </Text>
        <g data-k={`pic-form-${p.signIn}`}>
          <Box x={150} y={310} w={120} h={68} cls="sp-b" rx={8} />
          {p.signIn === "local" ? (
            <>
              <Box x={162} y={322} w={96} h={9} cls="sp-bar" rx={4.5} />
              <Box x={162} y={338} w={96} h={9} cls="sp-bar" rx={4.5} />
              <Box x={162} y={356} w={96} h={12} cls="sp-fx" rx={6} />
            </>
          ) : (
            <>
              <Box x={162} y={336} w={96} h={16} cls="sp-fx" rx={8} />
              <circle cx={174} cy={344} r={4} className="sp-chd" />
            </>
          )}
        </g>
        <Ring on={lit("signIn")} name="form" x={150} y={310} w={120} h={68} rx={8} />
        <Arrow x1={178} y1={276} x2={178} y2={228} />
        <Text x={188} y={258} cls="sp-ts" anchor="start">
          {fit(p.via, 220, 11.5)}
        </Text>
      </svg>
    </div>
  );
}
