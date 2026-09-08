/**
 * The console's stylesheet, served as one file.
 *
 * It inherits the project's visual register without its theatrics: an inspection bench is
 * a dark object, so there is one mode and no toggle, and the type is a humanist sans for
 * reading with a mono for everything a machine wrote. Where a person reads a sentence and
 * a machine record sits behind it, the record is disclosed rather than decorated.
 *
 * COLOUR HONESTY. The emissive values below are an interpretation. Fluorescence under a
 * 365 nm lamp is named in the sources by colour and never published as a value, so nothing
 * here is measured and nothing here should be presented as though it were. Blue-white is
 * what an uncontrolled substrate looks like under the lamp, so it means failure here and
 * is never used as an accent.
 */

export const STYLESHEET = `
:root {
  --field: #0b0c0e;
  --bench: #121418;
  --raised: #171a1f;
  --rule: #24272e;
  --rule-bright: #343943;
  --ink: #c7ccd6;
  --ink-quiet: #868d9b;
  --ink-bright: #eff0fc;
  --mark: #7de3a0;
  --fail: #dde9ff;
  --warn: #f0b429;
  --measure: 68ch;
}

*, *::before, *::after { box-sizing: border-box; }

html {
  color-scheme: dark;
  background: var(--field);
}

body {
  margin: 0;
  background: var(--field);
  color: var(--ink);
  font-family: "Public Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

code, kbd, samp, pre, .mono, .measure, td.num {
  font-family: "IBM Plex Mono", ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

a { color: var(--ink-bright); text-decoration-color: var(--rule-bright); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--mark); }
:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }

.shell {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px 96px;
}

/* The header is the bench label: what this is, and which workspace it is looking at. */
.bench {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 20px;
  padding: 22px 0 18px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 32px;
}
.bench h1 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-bright);
  margin: 0;
}
.bench .path {
  font-size: 12px;
  color: var(--ink-quiet);
  margin-left: auto;
}

h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--ink-bright);
  margin: 40px 0 4px;
  text-wrap: balance;
}
h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-bright);
  margin: 28px 0 4px;
}
p { max-width: var(--measure); margin: 0 0 14px; }
.quiet { color: var(--ink-quiet); }
.lede { color: var(--ink-quiet); margin-top: 0; }

/* A label a machine would print: small, spaced, mono. */
.label {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-quiet);
}

.card {
  background: var(--bench);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 18px 20px;
}

.stack { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

/* Every experience reads the same way down the list: name, id, state. */
.entry {
  display: grid;
  gap: 4px;
  background: var(--bench);
  border: 1px solid var(--rule);
  border-left: 2px solid var(--rule-bright);
  border-radius: 3px;
  padding: 16px 18px;
}
.entry:hover { border-left-color: var(--mark); }
.entry .name { font-size: 16px; font-weight: 600; color: var(--ink-bright); }
.entry .meta { font-size: 12px; color: var(--ink-quiet); }

/*
 * The reveal. A verdict is a sentence a person acts on; the measurement behind it is what
 * the compiler actually produced. Disclosed with the platform's own element so it works
 * with no script and answers the keyboard.
 */
details.record { margin-top: 14px; border-top: 1px solid var(--rule); padding-top: 12px; }
details.record > summary {
  cursor: pointer;
  list-style: none;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-quiet);
  display: flex;
  align-items: center;
  gap: 8px;
}
details.record > summary::-webkit-details-marker { display: none; }
details.record > summary::before {
  content: "";
  width: 18px;
  height: 1px;
  background: var(--rule-bright);
  transition: background 120ms ease, box-shadow 120ms ease;
}
details.record[open] > summary { color: var(--mark); }
details.record[open] > summary::before {
  background: var(--mark);
  box-shadow: 0 0 6px var(--mark);
}
details.record > summary:hover { color: var(--ink); }

/* What the lamp shows: the machine's own record, emissive on the dark field. */
.record-body {
  margin-top: 12px;
  padding: 14px 16px;
  background: var(--field);
  border: 1px solid var(--rule);
  border-radius: 3px;
  font-size: 13px;
  color: var(--mark);
  text-shadow: 0 0 12px rgba(125, 227, 160, 0.28);
  overflow-x: auto;
}
.record-body table { width: 100%; border-collapse: collapse; }
.record-body th {
  text-align: left;
  font-weight: 400;
  color: var(--ink-quiet);
  text-shadow: none;
  padding: 3px 20px 3px 0;
  white-space: nowrap;
}
.record-body td { padding: 3px 0; text-align: right; white-space: nowrap; }

.verdict { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.verdict .state { font-size: 18px; font-weight: 600; color: var(--ink-bright); }
.verdict.pass .state { color: var(--mark); }
/* Blue-white is what an uncontrolled substrate looks like under the lamp. */
.verdict.fail .state { color: var(--fail); }
.verdict .score { font-size: 13px; color: var(--ink-quiet); }

.reasons { margin: 10px 0 0; padding-left: 18px; color: var(--warn); font-size: 13px; }
.reasons li { margin: 2px 0; }

form { margin: 0; }
fieldset { border: 0; margin: 0; padding: 0; }
label { display: block; font-size: 12px; color: var(--ink-quiet); margin-bottom: 5px; }
input[type="text"], input[type="number"], input[type="url"], input[type="file"], select, textarea {
  width: 100%;
  background: var(--field);
  color: var(--ink-bright);
  border: 1px solid var(--rule-bright);
  border-radius: 2px;
  padding: 8px 10px;
  font: inherit;
  font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-size: 13px;
}
input[type="file"] { padding: 6px; color: var(--ink); }
input:focus, select:focus, textarea:focus { border-color: var(--mark); outline: none; }
.field { flex: 1 1 200px; min-width: 0; }
.field.narrow { flex: 0 1 150px; }

button {
  background: var(--raised);
  color: var(--ink-bright);
  border: 1px solid var(--rule-bright);
  border-radius: 2px;
  padding: 8px 16px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
button:hover { border-color: var(--mark); color: var(--mark); }
button.primary { border-color: var(--mark); color: var(--mark); }
button.primary:hover { background: rgba(125, 227, 160, 0.08); }
button[disabled] { opacity: 0.45; cursor: default; border-color: var(--rule); color: var(--ink-quiet); }

.notice {
  border: 1px solid var(--rule-bright);
  border-left: 2px solid var(--warn);
  background: var(--bench);
  border-radius: 3px;
  padding: 12px 16px;
  margin: 0 0 20px;
  font-size: 13px;
}
.notice.bad { border-left-color: var(--fail); }
.notice.good { border-left-color: var(--mark); }
.notice p:last-child { margin-bottom: 0; }

.files { font-size: 12px; color: var(--ink-quiet); columns: 2; column-gap: 28px; margin: 8px 0 0; padding-left: 16px; }

.empty {
  border: 1px dashed var(--rule-bright);
  border-radius: 3px;
  padding: 28px 20px;
  color: var(--ink-quiet);
  font-size: 14px;
}

/*
 * Spacing and small type as classes rather than style attributes.
 *
 * Not a preference. The console sends a style-src of self, which blocks every inline style
 * attribute, so a page built with them renders unstyled in a real browser while every
 * string assertion about its HTML still passes. That is what happened, and it was found
 * by opening the page rather than by any test.
 */
.plain { text-decoration: none; }
.flush { margin: 0; }
.small { font-size: 13px; }
.detail { font-size: 12px; }
.broken { color: var(--fail); }
.gap-md { margin-top: 12px; }
.gap-lg { margin-top: 20px; }
.gap-xl { margin-top: 36px; }
.note { font-size: 12px; margin: 12px 0 0; }
.width-line { font-size: 13px; margin: 8px 0 0; }
.source-line { font-size: 12px; margin: 4px 0 14px; }
.row.bottom { align-items: flex-end; }
.row.spread { justify-content: space-between; align-items: baseline; }

@media (max-width: 620px) {
  .shell { padding: 0 16px 72px; }
  .bench .path { margin-left: 0; width: 100%; }
  .files { columns: 1; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
