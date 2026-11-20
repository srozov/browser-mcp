// Named profiles a caller brings: directories in the profile root that the daemon never creates, clones or
// deletes. The hold on one lives in the browser table (browsers.mjs), not here: these are pure checks.

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

// The real path of p; for a path that does not exist yet, its nearest existing parent's real path plus the rest.
function real(p) {
  return existsSync(p) ? realpathSync(p) : join(real(dirname(p)), basename(p));
}

const inside = (a, b) => a === b || a.startsWith(b + sep);

/** The startup check: the root exists and overlaps neither the base profile nor the clones (which startup wipes). */
export function checkProfileRoot({ root, baseProfile, clones }) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`BROWSER_PROFILE_ROOT is not a directory: ${root}`);
  }
  const r = real(root);
  for (const [other, label] of [[baseProfile, "BROWSER_BASE_PROFILE"], [clones, "the state directory's profiles/"]]) {
    const x = real(other);
    if (inside(r, x) || inside(x, r)) {
      throw new Error(`BROWSER_PROFILE_ROOT (${root}) must not be, contain or sit inside ${label} (${other})`);
    }
  }
}

/** A caller's profile name to its directory in the root. A symlink is refused: one profile must have one name. */
export function profilePath(root, name) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`profile "${name}" is not a profile name: give the name of a directory in the profile root, not a path`);
  }
  const dir = join(root, name);
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) throw new Error(`no profile "${name}" in the profile root: make it first (see the README)`);
  if (!st.isDirectory()) throw new Error(`profile "${name}" is not a plain directory in the profile root (a symlink or a file)`);
  return dir;
}
