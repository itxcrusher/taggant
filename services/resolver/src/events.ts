/**
 * A scan event, with one definition.
 *
 * Everyone who sells this kind of system counts scans, and almost nobody says what a scan
 * is, which is how two reports of the same week disagree by a factor of three. So it is
 * written down here and the code follows it rather than the other way round.
 *
 * **A scan is one request that resolved a Digital Link identifier to an answer.** That
 * means:
 *
 * - A redirect to a link is a scan. So is a linkset returned to something that asked for
 *   one, because both are a client getting an answer about an identifier.
 * - A request that could not be read as a Digital Link is not a scan. It never named an
 *   identifier, so there is nothing to count it against.
 * - A request for an identifier nothing is linked to is a scan, recorded as unresolved. It
 *   is a real person pointing a camera at a real printed thing, and it is the most useful
 *   number in the system: it is how a code that was printed but never assigned is found.
 * - The description file and the context file are not scans. They are about the resolver.
 * - A HEAD is a scan, because clients use it to follow a link without fetching it, and
 *   excluding it undercounts silently.
 *
 * What is deliberately not here: anything identifying a person. No address, no user agent
 * string, no cookie. The language is kept because it decided which link was chosen and a
 * report that cannot explain its own redirects is not much of a report.
 */
export interface ScanEvent {
  type: "scan";
  /** When the answer was given, as an ISO 8601 instant. */
  at: string;
  /** The canonical identifier that was resolved. */
  identifier: string;
  /** What the client got. */
  outcome: "redirect" | "linkset" | "unresolved";
  /** The link type asked for, if the request named one. */
  requested?: string;
  /** Where the client was sent, for a redirect. */
  target?: string;
  /** The language that decided the choice, when one did. */
  language?: string;
  /** How long the resolver took, in milliseconds, to a tenth. */
  tookMs: number;
}

export interface ProblemEvent {
  type: "problem";
  at: string;
  /** Why the request could not be answered. */
  reason: string;
  /** The path as asked for, which is the thing that needs fixing. */
  path: string;
  status: number;
}

export type Event = ScanEvent | ProblemEvent;

/** Where events go. Replaceable so a deployment can send them somewhere other than stdout. */
export type EventSink = (event: Event) => void;

/**
 * One JSON object per line on standard output.
 *
 * The format every log collector reads without being configured, and the one that survives
 * a container being restarted by something that was not asked first.
 */
export function jsonLines(write: (line: string) => void = (line) => process.stdout.write(line)): EventSink {
  return (event) => write(`${JSON.stringify(event)}\n`);
}

/** Counters, in the text format Prometheus and everything that imitates it reads. */
export class Counters {
  private readonly scans = new Map<string, number>();
  private problems = 0;
  private totalMs = 0;
  private answered = 0;

  record(event: Event): void {
    if (event.type === "problem") {
      this.problems++;
      return;
    }
    this.scans.set(event.outcome, (this.scans.get(event.outcome) ?? 0) + 1);
    this.totalMs += event.tookMs;
    this.answered++;
  }

  render(): string {
    const lines = [
      "# HELP taggant_scans_total Requests that resolved an identifier to an answer.",
      "# TYPE taggant_scans_total counter",
    ];
    for (const outcome of ["redirect", "linkset", "unresolved"]) {
      lines.push(`taggant_scans_total{outcome="${outcome}"} ${this.scans.get(outcome) ?? 0}`);
    }
    lines.push(
      "# HELP taggant_bad_requests_total Requests that could not be read as a Digital Link.",
      "# TYPE taggant_bad_requests_total counter",
      `taggant_bad_requests_total ${this.problems}`,
      "# HELP taggant_resolve_seconds_total Time spent resolving, in seconds.",
      "# TYPE taggant_resolve_seconds_total counter",
      `taggant_resolve_seconds_total ${(this.totalMs / 1000).toFixed(6)}`,
      "# HELP taggant_answered_total Answers given, for averaging the line above.",
      "# TYPE taggant_answered_total counter",
      `taggant_answered_total ${this.answered}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
