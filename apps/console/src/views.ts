/**
 * The pages, rendered as strings.
 *
 * Everything that reaches a page goes through `esc`. An experience title, a target id, a
 * filename and a compiler message are all written by someone, and this is a tool whose
 * whole job is to accept files and names from people. There is no template engine doing
 * this quietly in the background, so it is done here and it is done everywhere.
 */

import type { Report } from "@taggant/compiler";
import {
  type DraftManifest,
  ID_PATTERN_ATTRIBUTE,
  type Listed,
  TARGET_ID_PATTERN_ATTRIBUTE,
} from "./workspace.js";

/** HTML escaping, for text and for attribute values alike. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Notice {
  tone: "good" | "bad" | "warn";
  message: string;
  detail?: string;
}

export interface Chrome {
  title: string;
  workspaceRoot: string;
  notice?: Notice | undefined;
  body: string;
}

export function page({ title, workspaceRoot, notice, body }: Chrome): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/console.css">
</head>
<body>
<div class="shell">
  <header class="bench">
    <h1><a href="/" class="plain">taggant console</a></h1>
    <span class="path mono">${esc(workspaceRoot)}</span>
  </header>
  ${notice ? renderNotice(notice) : ""}
  ${body}
</div>
</body>
</html>
`;
}

function renderNotice(notice: Notice): string {
  const tone = notice.tone === "good" ? "good" : notice.tone === "bad" ? "bad" : "";
  return `<div class="notice ${tone}" role="status">
  <p>${esc(notice.message)}</p>
  ${notice.detail ? `<p class="quiet mono detail">${esc(notice.detail)}</p>` : ""}
</div>`;
}

/** The list of experiences, which is the list of folders in the workspace. */
export function indexPage(experiences: Listed[]): string {
  const entries = experiences
    .map((entry) => {
      if (!entry.ok) {
        return `<div class="entry">
  <span class="name">${esc(entry.id)}</span>
  <span class="meta broken">${esc(entry.reason)}</span>
</div>`;
      }
      const targets = entry.manifest.targets.length;
      const content = entry.manifest.targets.reduce((total, target) => total + target.content.length, 0);
      return `<a class="entry plain" href="/e/${esc(entry.id)}">
  <span class="name">${esc(entry.manifest.title ?? entry.id)}</span>
  <span class="meta mono">${esc(entry.id)} &middot; ${targets} target${targets === 1 ? "" : "s"} &middot; ${content} content item${content === 1 ? "" : "s"}</span>
</a>`;
    })
    .join("\n");

  return `<h2>Experiences</h2>
<p class="lede">One folder each, holding a manifest and the files it names. Everything here can be copied somewhere else and still work.</p>

${
  experiences.length > 0
    ? `<div class="grid gap-lg">${entries}</div>`
    : `<div class="empty">Nothing here yet. An experience is a manifest and the artwork it names, and the first one starts below.</div>`
}

<h3>Start one</h3>
<form method="post" action="/experiences" class="card gap-md">
  <div class="row bottom">
    <div class="field">
      <label for="new-id">Id</label>
      <input id="new-id" name="id" type="text" required pattern="${ID_PATTERN_ATTRIBUTE}"
             placeholder="botanica-500" autocomplete="off" spellcheck="false">
    </div>
    <div class="field">
      <label for="new-title">Title</label>
      <input id="new-title" name="title" type="text" placeholder="Botanica 500 ml" autocomplete="off">
    </div>
    <button class="primary" type="submit">Create</button>
  </div>
  <p class="quiet note">The id becomes the folder name, the address of the published bundle, and the code's destination, so it is fixed once anything is printed.</p>
</form>`;
}

function reportRecord(report: Report): string {
  const rows: [string, string][] = [
    ["features", String(report.featureCount)],
    ["areas reached", `${report.areasWithFeatures} of ${report.areas}`],
    ["analysed at", `${report.analysisWidth} px across`],
    ["smallest usable size", `${Math.round(report.smallestUsableScale * 100)}% of that`],
    ["repetition", report.repetition === null ? "not measured" : report.repetition.toFixed(2)],
    ["score", `${report.score} of 100, passing at 60`],
  ];
  return `<details class="record">
  <summary>Under the lamp: what the compiler measured</summary>
  <div class="record-body">
    <table>
      ${rows.map(([key, value]) => `<tr><th scope="row">${esc(key)}</th><td>${esc(value)}</td></tr>`).join("\n      ")}
    </table>
  </div>
</details>`;
}

/** The print readiness verdict: the sentence, then the measurement behind it. */
export function verdict(report: Report, scanDistanceMm: number): string {
  const width =
    report.minimumWidthMm === null
      ? "no width, because no width would fix it"
      : `${report.minimumWidthMm} mm wide to be read from ${scanDistanceMm} mm away, being ${Math.round(
          report.smallestUsableScale * report.analysisWidth,
        )} px across the artwork`;
  return `<div class="verdict ${report.pass ? "pass" : "fail"}">
  <span class="state">${report.pass ? "Ready for press" : "Not ready"}</span>
  <span class="score mono">${esc(report.score)} / 100</span>
</div>
<p class="mono width-line">Print it at least ${esc(width)}.</p>
${
  report.reasons.length > 0
    ? `<ul class="reasons">${report.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>`
    : ""
}
${reportRecord(report)}`;
}

export interface TargetView {
  id: string;
  source: string;
  physicalWidthMm: number;
  contentCount: number;
  report?: Report | undefined;
  scanDistanceMm?: number | undefined;
  /** Set when the compiled target asks for more width than the manifest says it is printed at. */
  tooSmall?: string | undefined;
}

export interface ExperienceView {
  id: string;
  manifest: DraftManifest;
  targets: TargetView[];
  /** What the schema still objects to. Empty means it can be published. */
  problems: { path: string; message: string }[];
  published?: { files: number; at: string } | undefined;
  code?: { path: string; href: string } | undefined;
}

export function experiencePage(view: ExperienceView): string {
  const targets = view.targets
    .map(
      (target) => `<section class="card">
  <div class="row spread">
    <h3 class="flush">${esc(target.id)}</h3>
    <span class="label">${esc(target.physicalWidthMm)} mm wide in print</span>
  </div>
  <p class="quiet mono source-line">${esc(target.source)} &middot; ${target.contentCount} content item${target.contentCount === 1 ? "" : "s"}</p>
  ${
    target.report
      ? verdict(target.report, target.scanDistanceMm ?? 350)
      : `<p class="quiet small">Not compiled yet, so nothing is known about whether it will track.</p>`
  }
  ${target.tooSmall ? `<div class="notice bad gap-md"><p>${esc(target.tooSmall)}</p></div>` : ""}
  <form method="post" action="/e/${esc(view.id)}/targets/${encodeURIComponent(target.id)}/compile" class="gap-md">
    <div class="row bottom">
      <div class="field narrow">
        <label for="d-${esc(target.id)}">Read from, mm</label>
        <input id="d-${esc(target.id)}" name="scanDistanceMm" type="number" min="50" max="5000" step="10" value="${esc(target.scanDistanceMm ?? 350)}">
      </div>
      <button type="submit">${target.report ? "Compile again" : "Compile"}</button>
    </div>
  </form>

  <details class="record">
    <summary>Add content to this target</summary>
    <form method="post" action="/e/${esc(view.id)}/targets/${encodeURIComponent(target.id)}/content" enctype="multipart/form-data" class="gap-md">
      <div class="row bottom">
        <div class="field narrow">
          <label for="ct-${esc(target.id)}">Type</label>
          <select id="ct-${esc(target.id)}" name="type">
            <option value="video">video</option>
            <option value="image">image</option>
            <option value="model">model</option>
            <option value="audio">audio</option>
          </select>
        </div>
        <div class="field">
          <label for="cf-${esc(target.id)}">File</label>
          <input id="cf-${esc(target.id)}" name="file" type="file" required>
        </div>
        <button type="submit">Add</button>
      </div>
    </form>
  </details>
</section>`,
    )
    .join("\n");

  return `<h2>${esc(view.manifest.title ?? view.id)}</h2>
<p class="lede mono small">${esc(view.id)}</p>

<h3>Targets</h3>
<p class="quiet small">Artwork the camera recognises. Each one is compiled before it can be published, and the compile says whether it will hold at the size it will actually be printed.</p>

${
  view.targets.length > 0
    ? `<div class="stack gap-md">${targets}</div>`
    : `<div class="empty">No targets yet. Add the artwork that will be printed.</div>`
}

<h3>Add a target</h3>
<form method="post" action="/e/${esc(view.id)}/targets" enctype="multipart/form-data" class="card gap-md">
  <div class="row bottom">
    <div class="field narrow">
      <label for="t-id">Target id</label>
      <input id="t-id" name="targetId" type="text" required pattern="${TARGET_ID_PATTERN_ATTRIBUTE}" placeholder="front-panel" autocomplete="off" spellcheck="false">
    </div>
    <div class="field narrow">
      <label for="t-width">Printed width, mm</label>
      <input id="t-width" name="physicalWidthMm" type="number" min="1" max="10000" step="1" required placeholder="62">
    </div>
    <div class="field">
      <label for="t-file">Artwork</label>
      <input id="t-file" name="artwork" type="file" required accept="image/*">
    </div>
    <button class="primary" type="submit">Add</button>
  </div>
  <p class="quiet note">Printed width is what the artwork actually measures on the finished piece. The compiler compares it against the width the artwork needs and says so if the print would be too small to read.</p>
</form>

<h3>Publish</h3>
<p class="quiet small">Writes a folder that runs on its own: the entry page, the manifest, the compiled targets, the assets, and the runtime carried in. It does not call back here, so this console can be switched off afterwards.</p>
${
  view.problems.length > 0
    ? `<div class="notice gap-md">
  <p>Not ready to publish yet. A published bundle is the one thing that has to be valid, so the manifest is held to the format until it is:</p>
  <ul class="reasons">${view.problems.map((problem) => `<li>${esc(describeProblem(problem, view.manifest))}</li>`).join("")}</ul>
</div>`
    : ""
}
${
  view.published
    ? `<div class="notice good gap-md"><p>Published ${esc(view.published.files)} files at ${esc(view.published.at)}.</p></div>`
    : ""
}
<form method="post" action="/e/${esc(view.id)}/publish" class="gap-md">
  <button class="primary" type="submit"${view.problems.length > 0 ? " disabled" : ""}>Publish</button>
</form>

<h3>Point a code at it</h3>
<p class="quiet small">Writes the resolver's link table, which the resolver watches. Nothing is called: the table is a file, and the operator owns it.</p>
${
  view.code
    ? `<div class="notice good gap-md"><p class="mono detail">${esc(view.code.path)} &rarr; ${esc(view.code.href)}</p></div>`
    : ""
}
<form method="post" action="/e/${esc(view.id)}/code" class="card gap-md">
  <div class="row bottom">
    <div class="field">
      <label for="c-path">Digital Link path</label>
      <input id="c-path" name="path" type="text" required placeholder="/01/09520123456788" autocomplete="off" spellcheck="false">
    </div>
    <div class="field">
      <label for="c-href">Destination</label>
      <input id="c-href" name="href" type="url" required placeholder="https://example.com/b/${esc(view.id)}/">
    </div>
    <button type="submit">Register</button>
  </div>
</form>

<p class="gap-xl"><a href="/">Back to every experience</a></p>`;
}

export function errorPage(status: number, message: string): string {
  return `<h2>${status}</h2><p>${esc(message)}</p><p><a href="/">Back to every experience</a></p>`;
}

/**
 * What the schema objected to, said the way a person would say it.
 *
 * The validator's own wording is a JSON pointer and a sentence about item counts, which
 * is the right thing for a build log and the wrong thing for the one message shown to
 * somebody who cannot publish and wants to know what to do next. Anything not recognised
 * here falls through with its pointer intact rather than being hidden.
 */
export function describeProblem(problem: { path: string; message: string }, manifest: DraftManifest): string {
  if (problem.path === "/targets" && problem.message.includes("fewer than 1")) {
    return "There is no target yet, so there is nothing for a camera to recognise. Add the artwork that will be printed.";
  }
  const target = problem.path.match(/^\/targets\/(\d+)(\/|$)/);
  const index = target?.[1] === undefined ? undefined : Number(target[1]);
  const named = index === undefined ? undefined : manifest.targets[index]?.id;
  if (named !== undefined && problem.path.endsWith("/content") && problem.message.includes("fewer than 1")) {
    return `${named} has nothing to show. Add content to it.`;
  }
  return named === undefined
    ? `${problem.path} ${problem.message}`
    : `${named}: ${problem.path.replace(/^\/targets\/\d+/, "")} ${problem.message}`.trim();
}
