import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProfileRoot, profilePath } from "../src/profiles.mjs";

const tmp = mkdtempSync(join(tmpdir(), "browser-mcp-profiles-"));
const root = join(tmp, "root");
const base = join(tmp, "base");
const state = join(tmp, "state");
const clones = join(state, "profiles");

before(() => {
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(base);
  mkdirSync(join(tmp, "elsewhere"));
  mkdirSync(join(base, "inner"));
  mkdirSync(state);
  writeFileSync(join(root, "file"), "");
  symlinkSync(join(root, "a"), join(root, "inlink"));
  symlinkSync(join(tmp, "elsewhere"), join(root, "outlink"));
  symlinkSync(base, join(tmp, "baselink"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("profilePath", () => {
  it("gives the directory of an existing profile", () => {
    assert.equal(profilePath(root, "a"), join(root, "a"));
  });
  it("refuses what is not a name", () => {
    for (const name of ["", ".", "..", "a/b", "../a", "/etc", "x\0"]) {
      assert.throws(() => profilePath(root, name), /not a profile name/, JSON.stringify(name));
    }
  });
  it("refuses a name not in the root", () => {
    assert.throws(() => profilePath(root, "missing"), /no profile "missing"/);
  });
  it("refuses a file and symlinks", () => {
    for (const name of ["file", "inlink", "outlink"]) assert.throws(() => profilePath(root, name), /not a plain directory/, name);
  });
});

describe("checkProfileRoot", () => {
  const check = (r) => () => checkProfileRoot({ root: r, baseProfile: base, clones });
  it("accepts a root beside the base profile and the state directory", () => {
    check(root)();
  });
  it("refuses a missing root", () => {
    assert.throws(check(join(tmp, "nope")), /is not a directory/);
  });
  it("refuses a root that is, is inside or contains the base profile", () => {
    for (const r of [base, join(base, "inner"), tmp]) assert.throws(check(r), /BROWSER_BASE_PROFILE/, r);
  });
  it("refuses a root that is, contains or is inside the clones", () => {
    mkdirSync(join(clones, "h"), { recursive: true });
    for (const r of [clones, state, join(clones, "h")]) assert.throws(check(r), /profiles\//, r);
  });
  it("sees through a symlink to the base profile", () => {
    assert.throws(check(join(tmp, "baselink")), /BROWSER_BASE_PROFILE/);
  });
});
