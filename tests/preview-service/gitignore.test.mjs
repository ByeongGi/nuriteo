import assert from "node:assert/strict";

import { createGitignoreMatcher } from "../../apps/preview-service/src/lib/gitignore.ts";

const matcher = createGitignoreMatcher(`
# generated output
/dist/
node_modules/
*.log
temp?.txt
cache/**/generated.*
!important.log
docs/*.log
!docs/keep.log
`);

assert.equal(matcher.isIgnored(".gitignore", false), false, ".gitignore must remain visible");
assert.equal(matcher.isIgnored("dist", true), true, "leading slash must match a root directory");
assert.equal(matcher.isIgnored("dist/app.js", false), true, "directory rules must include descendants");
assert.equal(matcher.isIgnored("nested/dist", true), false, "leading slash must anchor at the project root");
assert.equal(matcher.isIgnored("node_modules", true), true, "directory names must match at any depth");
assert.equal(matcher.isIgnored("packages/app/node_modules/react/index.js", false), true);
assert.equal(matcher.isIgnored("debug.log", false), true, "star must not cross path separators");
assert.equal(matcher.isIgnored("logs/debug.log", false), true, "patterns without slashes match any segment");
assert.equal(matcher.isIgnored("important.log", false), false, "later negation must restore a file");
assert.equal(matcher.isIgnored("temp1.txt", false), true, "question mark must match one character");
assert.equal(matcher.isIgnored("temp12.txt", false), false);
assert.equal(matcher.isIgnored("cache/generated.js", false), true, "globstar directory may match zero segments");
assert.equal(matcher.isIgnored("cache/a/b/generated.css", false), true, "globstar must cross directories");
assert.equal(matcher.isIgnored("docs/other.log", false), true, "slash patterns are project-relative");
assert.equal(matcher.isIgnored("docs/keep.log", false), false, "the last matching rule wins");

const projectRelative = createGitignoreMatcher("docs/*.txt\n");
assert.equal(projectRelative.isIgnored("docs/guide.txt", false), true, "slash patterns match from the root");
assert.equal(projectRelative.isIgnored("src/docs/guide.txt", false), false);

const directoryOnly = createGitignoreMatcher("build/\n");
assert.equal(directoryOnly.isIgnored("build", false), false, "trailing slash must not hide a same-name file");
assert.equal(directoryOnly.isIgnored("build", true), true);

console.log("preview service gitignore matcher ok");
