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
 * - A request the table has no link to answer with is a scan, recorded as unresolved: an
 *   identifier nothing is linked to, a link type its links do not have, or no default when
 *   no type was asked for. Of those, an identifier with nothing linked to it or further up
 *   its hierarchy is how a code that was printed but never assigned is found. The count is of
 *   requests, which anyone can send, so it says which codes to look at rather than how many
 *   people looked.
 * - The description file and the context file are not scans. They are about the resolver.
 * - A HEAD is a scan, because clients use it to follow a link without fetching it, and
 *   excluding it undercounts silently.
 *
 * What is deliberately not here: anything about whoever scanned. No address, no user agent
 * string, no cookie. The identifier is the code's own, and a code can name a person: a
 * service relation number names the recipient of a service, and a serial number or a lot
 * holds whatever was printed in it, so a log of these events holds whatever its codes name.
 * The language is kept because it decided which link was chosen and a report that cannot
 * explain its own redirects is not much of a report.
 */
export interface ScanEvent {
  type: "scan";
  /** When the answer was given, as an ISO 8601 instant. */
  at: string;
  /** The canonical identifier that was resolved. */
  identifier: string;
  /** What the client got. */
  outcome: "redirect" | "linkset" | "unresolved";
  /**
   * The link type asked for, if the request named one that the identifier's links have or one
   * of the link types of the GS1 vocabulary. Anything else is left out, being a caller's own
   * text, and a term of the vocabulary that is not a link type, such as `gs1:Product`, with it.
   */
  requested?: string;
  /**
   * The link the table chose, for a redirect: where the client was sent, without the query string
   * the redirect carried on to it from the request.
   */
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
  /** The path as asked for, without its query, which is the thing that needs fixing. */
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
  private badRequests = 0;
  private serverErrors = 0;
  private totalMs = 0;

  record(event: Event): void {
    if (event.type === "problem") {
      // A request that could not be read is the caller's mistake, and one this resolver failed
      // to answer is its own. Only the second is worth waking somebody for, so they are apart.
      if (event.status >= 500) this.serverErrors++;
      else this.badRequests++;
      return;
    }
    this.scans.set(event.outcome, (this.scans.get(event.outcome) ?? 0) + 1);
    this.totalMs += event.tookMs;
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
      "# HELP taggant_bad_requests_total Requests the resolver could not read as a Digital Link. One the HTTP parser refuses is answered before it reaches the resolver, and is not counted.",
      "# TYPE taggant_bad_requests_total counter",
      `taggant_bad_requests_total ${this.badRequests}`,
      // There was a `taggant_answered_total` here as the denominator for the line above,
      // and it is gone. It counted one per scan, so it was exactly the sum of the scan
      // counter under a name that claimed more: the resolver answers health checks,
      // readiness checks, metrics scrapes and bad requests as well, and none of those were
      // in it, so a dashboard reading it as a request rate read low by however often an
      // orchestrator polls. Two numbers that must stay equal are two numbers that can
      // drift, and the sum is one expression away.
      "# HELP taggant_server_errors_total Requests this resolver failed to answer, through a fault of its own.",
      "# TYPE taggant_server_errors_total counter",
      `taggant_server_errors_total ${this.serverErrors}`,
      "# HELP taggant_resolve_seconds_total Time spent resolving, in seconds. Divide by sum(taggant_scans_total) for the mean.",
      "# TYPE taggant_resolve_seconds_total counter",
      `taggant_resolve_seconds_total ${(this.totalMs / 1000).toFixed(6)}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
