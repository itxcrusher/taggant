/**
 * What a run is not allowed to skip, said by the machine running it.
 *
 * A browser that installs and then will not launch used to be warned about and skipped,
 * which is right on a contributor's machine with one browser and wrong on the machine that
 * is supposed to be earning the claim. So both lists are comma separated, both are empty
 * unless set, and CI sets both to all three.
 *
 * Shared, so the files that read them cannot drift on the names.
 */
function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

/** Engines that must start. A machine without one otherwise narrows the run quietly. */
export function requiredEngines(): string[] {
  return list("TAGGANT_REQUIRE_ENGINES");
}

/**
 * Engines that must get from a camera to content on the artwork, not merely start.
 *
 * Separate from the list above because they are different properties and the second one
 * belongs to the platform: Playwright's WebKit has no capture API at all on Windows and has
 * a working one on Linux, so "webkit must launch" is reasonable everywhere and "webkit must
 * use a canvas as a camera" is only true where it can. Overloading one list with both meant
 * a contributor on Windows copying the CI setting got a failure that was not theirs to fix.
 */
export function requiredCameraEngines(): string[] {
  return list("TAGGANT_REQUIRE_CAMERA");
}
