/**
 * Which browser engines this run is not allowed to skip.
 *
 * A browser that installs and then will not launch used to be warned about and skipped,
 * which is right on a contributor's machine with one browser and wrong on the machine that
 * is supposed to be earning the claim. So the machine says: `TAGGANT_REQUIRE_ENGINES` is a
 * comma separated list, CI sets all three, and a test that could not use a named engine
 * fails rather than narrowing quietly.
 *
 * Shared so the two files that check engines cannot drift on the name of the variable.
 */
export function requiredEngines(): string[] {
  return (process.env.TAGGANT_REQUIRE_ENGINES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
