import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * `THIRD-PARTY-LICENCES.md` against the installed tree.
 *
 * A licence inventory is a list of claims about other people's code, and the one way it
 * goes wrong is quietly: a dependency is added, or bumps to a release under a different
 * licence, and the file goes on describing the tree as it was. So the file is compared
 * against what `pnpm` says is actually installed for production, every time.
 */
describe("the third-party licence inventory", () => {
  it("names every production dependency, at its installed version, under its licence", async () => {
    const { stdout } = await run("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: REPO,
      shell: process.platform === "win32",
      maxBuffer: 8 * 1024 * 1024,
    });
    const byLicence = JSON.parse(stdout) as Record<
      string,
      Array<{ name: string; versions?: string[]; version?: string }>
    >;
    const inventory = await readFile(join(REPO, "THIRD-PARTY-LICENCES.md"), "utf8");

    let checked = 0;
    const wrong: string[] = [];
    for (const [licence, packages] of Object.entries(byLicence)) {
      for (const pkg of packages) {
        const versions = pkg.versions ?? (pkg.version ? [pkg.version] : []);
        for (const version of versions) {
          checked++;
          // The row has to carry the name, the version and the licence together. A file
          // that names the package under an old version or an old licence is the failure
          // this exists to catch, so a name alone is not enough.
          // A platform package is matched against its family row: `sharp` declares one
          // optional package per operating system and architecture, the package manager
          // installs only the ones for the machine it is on, and the first version of the
          // inventory listed the Windows one and was caught by this test on its first push
          // to the Linux runner. The family row carries the version and the licence, which
          // are checked exactly; only the platform part of the name is left free.
          const family = new RegExp(
            `\\|\\s*\`${literal(familyOf(pkg.name))}\`\\s*\\|\\s*${literal(version)}\\s*\\|\\s*${literal(licence)}\\s*\\|`,
          );
          const plain = new RegExp(
            `\\|\\s*\`${literal(pkg.name)}\` ${literal(version)}\\s*\\|\\s*${literal(licence)}\\s*\\|`,
          );
          if (!family.test(inventory) && !plain.test(inventory)) {
            wrong.push(`${pkg.name} ${version} (${licence})`);
          }
        }
      }
    }
    expect(checked, "pnpm listed no production dependencies, so this checked nothing").toBeGreaterThan(5);
    expect(wrong, `installed but not in the inventory as installed: ${wrong.join(", ")}`).toEqual([]);
  }, 120_000);

  it("names nothing that is not installed, so a dependency taken out takes its row with it", async () => {
    // The other direction, and the file claimed it for several rounds without it: the walk
    // above requires every installed package to have a row, which catches one added or
    // relicensed and cannot catch one removed. A row for a package nothing depends on any
    // more is a document describing a tree that no longer exists, which is the failure this
    // repository has paid for more than any other.
    //
    // The platform families are the exception, and they are exempt by their nature rather
    // than by convenience: `sharp` declares one optional package per operating system and
    // architecture and only the machine's own are installed, so those rows describe every
    // platform deliberately. They are named here so the exemption is a list rather than a
    // pattern that could quietly cover something else.
    const { stdout } = await run("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: REPO,
      shell: process.platform === "win32",
      maxBuffer: 8 * 1024 * 1024,
    });
    const byLicence = JSON.parse(stdout) as Record<
      string,
      Array<{ name: string; versions?: string[]; version?: string }>
    >;
    const installed = new Set<string>();
    for (const packages of Object.values(byLicence)) {
      for (const pkg of packages) {
        for (const version of pkg.versions ?? (pkg.version ? [pkg.version] : [])) {
          installed.add(`${pkg.name} ${version}`);
          installed.add(`${familyOf(pkg.name)} ${version}`);
        }
      }
    }

    const inventory = await readFile(join(REPO, "THIRD-PARTY-LICENCES.md"), "utf8");
    // Every row that names a package and a version: `| `name` 1.2.3 |` in the dependency
    // tables, and `| `family` | 1.2.3 |` in the platform table.
    const rows = [
      ...inventory.matchAll(/\|\s*`([^`]+)`\s+(\d+\.\d+\.\d+)\s*\|/g),
      ...inventory.matchAll(/\|\s*`([^`]+)`\s*\|\s*(\d+\.\d+\.\d+)\s*\|/g),
    ];
    const named = new Set(rows.map(([, name, version]) => `${name} ${version}`));
    expect(named.size, "no rows were found in the inventory, so this checked nothing").toBeGreaterThan(5);

    const platforms = /^@img\/sharp(?:-libvips)?-/;
    const gone = [...named].filter((row) => !installed.has(row) && !platforms.test(row));
    expect(gone, `named in the inventory and not installed: ${gone.join(", ")}`).toEqual([]);
  }, 120_000);

  it("is declared in every package's own manifest, not only in the root file", async () => {
    // A registry or a scanner reads `package.json`, not `LICENSE`. Every one of these said
    // nothing for as long as the repository has existed.
    const manifests = [
      "package.json",
      "packages/bundler/package.json",
      "packages/compiler/package.json",
      "packages/manifest/package.json",
      "packages/runtime/package.json",
      "packages/vision/package.json",
      "apps/console/package.json",
      "services/resolver/package.json",
    ];
    for (const path of manifests) {
      const manifest = JSON.parse(await readFile(join(REPO, path), "utf8")) as { license?: string };
      expect(manifest.license, `${path} declares no licence`).toBe("MIT");
    }
  });

  it("is right that nothing from outside the workspace reaches the runtime", async () => {
    // The inventory says the runtime a bundle carries has no third-party code. That is a
    // property of two package manifests, so it is read off them rather than believed.
    for (const path of ["packages/runtime/package.json", "packages/vision/package.json"]) {
      const manifest = JSON.parse(await readFile(join(REPO, path), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const outside = Object.keys(manifest.dependencies ?? {}).filter(
        (name) => !name.startsWith("@taggant/"),
      );
      expect(
        outside,
        `${path} depends on ${outside.join(", ")}, which the inventory says it does not`,
      ).toEqual([]);
    }
  });
});

/**
 * The inventory row a platform package belongs to. Everything else is its own row.
 *
 * `@img/sharp-libvips-linux-arm` is one patch release ahead of its siblings and has a row of
 * its own; the rest of the libvips packages share one; the Windows prebuilts share one,
 * because theirs carry libvips inside and so name both licences; every other prebuilt
 * shares the last.
 */
function familyOf(name: string): string {
  if (name === "@img/sharp-libvips-linux-arm") return name;
  if (name.startsWith("@img/sharp-libvips-")) return "@img/sharp-libvips-<os>-<arch>";
  if (name.startsWith("@img/sharp-win32-")) return "@img/sharp-win32-<arch>";
  if (name.startsWith("@img/sharp-")) return "@img/sharp-<os>-<arch>";
  return name;
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
