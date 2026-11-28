import React from "react";

import { hostOf, type SetupAnswers } from "../../../../src/setup/answers";
import { pictureOf } from "../../../../src/setup/picture";

// What the control plane gets, and what a person's browser gets.
//
// HX Fortress on the organization's side holds the rows, the files and the
// keys. While it is connected it calls out to the control plane, which gets
// names, counts, states and times and nothing more, and never calls in. A
// person's browser gets its page from the control plane and its rows from
// HX Fortress. Switched off, or with no control plane at all, the browser
// shows HX Fortress's own console.
//
// Drawn from the answers of the control plane's section, so it follows the
// switch as a person flips it, before anything is saved. Whether the control
// plane is drawn connected is the page's to say (`on`): a connection that
// stands until the next start is drawn, though the saved answer is off.
//
// Every part is always drawn, and a change morphs it. The control plane's
// box fills and empties over the dashed frame of its place. The browser's
// page narrows from the console of HX Fortress to a page of it shown by the
// control plane (`clip-path`), and its name moves with it (`transform`). A
// part that goes fades out before the part that takes its place fades in, so
// two parts never fade through each other (settings.css, `.sw-part`).

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

function Text(props: { x: number; y: number; cls: string; anchor?: "start" | "middle" | "end"; children: string }): React.ReactElement {
  return (
    <text className={props.cls} x={props.x} y={props.y} textAnchor={props.anchor ?? "middle"}>
      {props.children}
    </text>
  );
}

/** Parts that are drawn in one state of the picture: shown, or faded out. */
function Part({ shown, children }: { shown: boolean; children: React.ReactNode }): React.ReactElement {
  return <g className={shown ? "sw-part" : "sw-part sw-gone"}>{children}</g>;
}

/** A small pill with a word in it: dark inside HX Fortress, light inside the
 *  control plane. */
function Chip({ x, y, w, word, dark }: { x: number; y: number; w: number; word: string; dark?: boolean }): React.ReactElement {
  return (
    <>
      <Box x={x} y={y} w={w} h={20} cls={dark ? "sp-chd" : "sp-ch"} rx={10} />
      <Text x={x + w / 2} y={y + 14} cls={dark ? "sp-chdt" : "sw-cht"}>
        {word}
      </Text>
    </>
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

/** The longest text that fits a width, roughly: monospace at `px`. */
function fitMono(text: string, max: number, px: number): string {
  const most = Math.max(4, Math.floor(max / (px * 0.6)));
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

export function WorldPicture({ answers, on, off }: { answers: SetupAnswers; on: boolean; off: string }): React.ReactElement {
  const pages = answers.controlPlane.pages.trim();
  // The control plane can show a page of this HX Fortress only where its
  // pages are named.
  const showsPage = on && pages !== "";
  const own = pictureOf(answers, { moduleTitles: {} });
  const side = own.band.split(" · ")[0] ?? own.band;
  const host = hostOf(answers.controlPlane.address);
  const describe = on
    ? `${side}: HX Fortress keeps rows, files and keys, calls out to the control plane at ${host}, and is never called in.`
    : `${side}: HX Fortress keeps rows, files and keys. The control plane: ${off}.`;

  return (
    <div className="su-panel st-world">
      <svg className="sp" viewBox="0 0 420 320" role="img" aria-label={describe}>
        <Box x={2} y={26} w={180} h={134} cls="sp-net" rx={20} />
        <CloudMark />
        <Text x={28} y={17} cls="sp-ts" anchor="start">
          {side}
        </Text>
        <Box x={12} y={40} w={160} h={106} cls="sp-fx" rx={14} />
        <Text x={92} y={67} cls="sp-fxt">
          HX Fortress
        </Text>
        <Chip x={21} y={81} w={44} word="rows" dark />
        <Chip x={71} y={81} w={42} word="files" dark />
        <Chip x={119} y={81} w={44} word="keys" dark />
        <Text x={92} y={127} cls="sp-fxm">
          stay on your side
        </Text>

        {/* The control plane's place: its dashed frame always, its box filled
            while it is connected. */}
        <CloudMark dx={274} />
        <Text x={302} y={17} cls="sp-ts" anchor="start">
          Control plane
        </Text>
        <Box x={276} y={26} w={140} h={134} cls="sp-ghost" rx={20} />
        <Part shown={on}>
          <Box x={276} y={26} w={140} h={134} cls="sp-cp" rx={20} />
          <Text x={346} y={52} cls="sp-tm">
            {fitMono(host, 128, 10.5)}
          </Text>
          <Chip x={291} y={66} w={50} word="names" />
          <Chip x={347} y={66} w={54} word="counts" />
          <Chip x={291} y={92} w={54} word="states" />
          <Chip x={351} y={92} w={50} word="times" />
          <Text x={346} y={138} cls="sp-ts">
            all it gets
          </Text>
          <Arrow x1={172} y1={68} x2={276} y2={68} cls="acc" />
          <Text x={229} y={60} cls="sp-ts">
            calls out
          </Text>
          <Arrow x1={276} y1={112} x2={202} y2={112} cls="sw-no" />
          <path className="sw-x" d="M186 106l10 12M196 106l-10 12" />
          <Text x={232} y={132} cls="sp-ts">
            never calls in
          </Text>
        </Part>
        <Part shown={!on}>
          <Text x={346} y={98} cls="sw-off">
            {off}
          </Text>
        </Part>

        <Box x={4} y={206} w={412} h={110} cls="sp-b" rx={12} />
        <path className="sp-l sp-rule" d="M4 230h412" />
        {[14, 24, 34].map((d) => (
          <circle key={d} className="sp-dot" cx={4 + d} cy={218} r={3} />
        ))}
        <Part shown={!showsPage}>
          <Text x={56} y={222} cls="sp-tm" anchor="start">
            {fitMono(own.address, 300, 10.5)}
          </Text>
        </Part>
        <Part shown={showsPage}>
          <Text x={56} y={222} cls="sp-tm" anchor="start">
            {fitMono(pages, 300, 10.5)}
          </Text>
        </Part>
        <Face cx={402} cy={218} />
        <Arrow x1={92} y1={146} x2={92} y2={206} />
        <Text x={102} y={190} cls="sp-ts" anchor="start">
          your rows
        </Text>

        {/* The browser's page: the console of HX Fortress across the whole
            width, or, narrowed to its left, a page of it that the control
            plane shows beside its own. */}
        <rect className={showsPage ? "sp-fx sw-page narrow" : "sp-fx sw-page"} x={16} y={242} width={388} height={62} rx={10} />
        <g className={showsPage ? "sw-name narrow" : "sw-name"}>
          <Part shown={!showsPage}>
            <Text x={210} y={268} cls="sp-fxm">
              the console of
            </Text>
          </Part>
          <Part shown={showsPage}>
            <Text x={210} y={268} cls="sp-fxm">
              a page from
            </Text>
          </Part>
          <Text x={210} y={286} cls="sp-fxt">
            HX Fortress
          </Text>
        </g>
        <Part shown={showsPage}>
          <Box x={192} y={246} w={170} h={7} cls="sp-bar" rx={3.5} />
          <Box x={192} y={262} w={120} h={7} cls="sp-bar" rx={3.5} />
          <Box x={192} y={278} w={196} h={7} cls="sp-bar" rx={3.5} />
          <Box x={192} y={294} w={96} h={7} cls="sp-bar" rx={3.5} />
          <Arrow x1={346} y1={160} x2={346} y2={206} />
          <Text x={356} y={190} cls="sp-ts" anchor="start">
            its page
          </Text>
        </Part>
      </svg>
    </div>
  );
}
