import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

runGit(["diff", "--check", "HEAD"]);
const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"]);
if (untracked.stdout.length > 0) {
  const count = untracked.stdout.toString("utf8").split("\0").filter(Boolean).length;
  throw new Error(`working-tree check found ${count} untracked file(s)`);
}

console.log("working-tree diff ok (tracked whitespace and untracked files checked)");

function runGit(arguments_: string[]) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("working-tree git check failed");
  }
  return result;
}
