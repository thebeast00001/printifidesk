// Brings the desk checkout up to date with the student repo, and refuses
// to run when that would be unsafe.
//
// The desk site is this same code deployed from a second repo. That is only
// safe while the second repo is *only ever pulled into*: a commit made there
// directly would either conflict with the next pull or, worse, not — and
// the desk would quietly run code the student site doesn't. So before
// pulling, this checks that the current checkout has nothing the upstream
// repo lacks and nothing uncommitted, and stops with a plain sentence if it
// does. Run from the desk checkout:
//
//   npm run sync:desk

import { execSync } from "node:child_process";

const git = (cmd) => execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const stop = (why) => {
  console.error(`\nNot syncing: ${why}`);
  process.exit(1);
};

let upstream;
try {
  upstream = git("remote get-url upstream");
} catch {
  stop("this checkout has no `upstream` remote. Add the student repo as upstream:\n  git remote add upstream https://github.com/thebeast00001/printifi.git");
}
const origin = git("remote get-url origin");
console.log(`upstream ${upstream}\norigin   ${origin}`);

if (git("status --porcelain")) {
  stop("there are uncommitted changes here. The desk checkout is a mirror; make the change in the student repo instead, then `git checkout -- .` here.");
}

git("fetch upstream main");
const local = git("rev-list --count upstream/main..HEAD");
if (local !== "0") {
  stop(
    `this checkout has ${local} commit(s) the student repo doesn't. Those belong in the student repo — ` +
      "cherry-pick them there (or `git reset --hard upstream/main` here to drop them), then sync again.",
  );
}

const behind = git("rev-list --count HEAD..upstream/main");
if (behind === "0") {
  console.log("Already up to date with upstream/main.");
} else {
  console.log(`Fast-forwarding ${behind} commit(s) from upstream/main…`);
  console.log(git("pull --ff-only upstream main"));
}
console.log(git("push origin main") || "origin is up to date.");
console.log(`\nDesk repo at ${git("rev-parse --short HEAD")} — identical to upstream/main.`);
