import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PROJECT_BUNDLE_ADMISSION_CONTRACT,
  ProjectBundleValidationError,
  validateProjectBundleV1Projection,
  type ProjectBundleValidationErrorCode,
  type RawProjectBundleV1Projection
} from "../src/bundles/project-bundle-v1-validation.ts";
import { writeValidatedProjectBundleV1, type ProjectBundleV1SourceFile } from "../src/bundles/project-bundle-v1.ts";

const encoder = new TextEncoder();
const projectId = "0199ee6c-c777-7000-8000-00000000c001";
const storageScopeId = "0199ee6c-c777-7000-8000-00000000c002";
const MEBIBYTE = 1024 * 1024;

const sharedContract = JSON.parse(
  await readFile(new URL("../../../compat/project-bundle-admission-v1.json", import.meta.url), "utf8")
) as unknown;
assert.deepEqual(PROJECT_BUNDLE_ADMISSION_CONTRACT, sharedContract);
assert.equal(Object.isFrozen(PROJECT_BUNDLE_ADMISSION_CONTRACT), true);
assert.equal(Object.isFrozen(PROJECT_BUNDLE_ADMISSION_CONTRACT.defaults), true);
assert.equal(Object.isFrozen(PROJECT_BUNDLE_ADMISSION_CONTRACT.systemExclusions.directoryNames), true);

const normalized = validateProjectBundleV1Projection(projection([
  file("src/cafe\u0301.ts", "café"),
  file("README.md", "read me")
]));
assert.deepEqual(normalized.files.map((entry) => entry.path), ["README.md", "src/café.ts"]);
assert.equal(Object.isFrozen(normalized), true);
assert.equal(Object.isFrozen(normalized.files), true);
assert.equal(Object.isFrozen(normalized.files[0]), true);

for (const path of [
  "", "/absolute", "C:/absolute", "../escape", "a/../escape", "a/./file", "a//file", "a/file/", "a\\file",
  "a\0file", "a\nfile", "a/\ud800file"
]) {
  expectValidationError(() => validateProjectBundleV1Projection(projection([file(path)])), "INVALID_PATH");
}
expectValidationError(() => validateProjectBundleV1Projection(projection([
  file("src/cafe\u0301.ts"),
  file("src/café.ts")
])), "DUPLICATE_PATH");

const segmentAtLimit = "a".repeat(255);
assert.equal(validateProjectBundleV1Projection(projection([file(segmentAtLimit)])).files[0]?.path, segmentAtLimit);
expectValidationError(() => validateProjectBundleV1Projection(projection([file("a".repeat(256))])), "INVALID_PATH");
const pathAtLimit = `${"a".repeat(255)}/${"b".repeat(253)}/cc`;
assert.equal(encoder.encode(pathAtLimit).byteLength, 512);
assert.equal(validateProjectBundleV1Projection(projection([file(pathAtLimit)])).files[0]?.path, pathAtLimit);
expectValidationError(() => validateProjectBundleV1Projection(projection([file(`${pathAtLimit}d`)])), "INVALID_PATH");
const depthAtLimit = Array.from({ length: 32 }, () => "a").join("/");
assert.equal(validateProjectBundleV1Projection(projection([file(depthAtLimit)])).files.length, 1);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(`${depthAtLimit}/a`)])),
  "INVALID_PATH"
);

const maxFile = new Uint8Array(16 * MEBIBYTE);
assert.equal(validateProjectBundleV1Projection(projection([file("max.bin", maxFile, "binary")])).files.length, 1);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file("too-large.bin", new Uint8Array(16 * MEBIBYTE + 1), "binary")])),
  "FILE_TOO_LARGE"
);
assert.equal(validateProjectBundleV1Projection(
  projection([file("logical.bin", maxFile, "binary")]),
  { maxLogicalBytes: 16 * MEBIBYTE }
).files.length, 1);
expectValidationError(
  () => validateProjectBundleV1Projection(
    projection([file("logical.bin", maxFile, "binary"), file("extra", Uint8Array.of(1), "binary")]),
    { maxLogicalBytes: 16 * MEBIBYTE }
  ),
  "LOGICAL_SIZE_EXCEEDED"
);

const maxFiles = Array.from({ length: 2_500 }, (_, index) => file(`f/${index.toString().padStart(4, "0")}`));
assert.equal(validateProjectBundleV1Projection(projection(maxFiles)).files.length, 2_500);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([...maxFiles, file("f/2500")])),
  "FILE_COUNT_EXCEEDED"
);

for (const limits of [
  { maxFileBytes: 0 },
  { maxFileBytes: 16 * MEBIBYTE + 1 },
  { maxLogicalBytes: 16 * MEBIBYTE - 1 },
  { maxLogicalBytes: 256 * MEBIBYTE + 1 },
  { maxFiles: 0 },
  { maxFiles: 2_501 },
  { maxDepth: 7 },
  { maxDepth: 65 },
  { maxPathBytes: 255 },
  { maxPathBytes: 1_025 },
  { unexpected: 1 }
]) {
  expectValidationError(
    () => validateProjectBundleV1Projection(projection([file("ok")]), limits),
    "INVALID_LIMITS"
  );
}
assert.equal(validateProjectBundleV1Projection(projection([file("ok", Uint8Array.of(1), "binary")]), {
  maxFileBytes: 1,
  maxLogicalBytes: 16 * MEBIBYTE,
  maxFiles: 1,
  maxDepth: 8,
  maxPathBytes: 256
}).files.length, 1);
assert.equal(validateProjectBundleV1Projection(projection([file("ok")]), {
  maxFileBytes: 16 * MEBIBYTE,
  maxLogicalBytes: 256 * MEBIBYTE,
  maxFiles: 2_500,
  maxDepth: 64,
  maxPathBytes: 1_024
}).files.length, 1);

const ignoreRules = [
  "*.log",
  "!important.log",
  "build/",
  "!build/",
  "build/*",
  "!build/keep.js",
  "nested/**/drop?.js",
  "/root-only.txt",
  "file-[0-3].tmp",
  "file-[!a-z].cache",
  "a**b.txt",
  "\\#notes",
  "\\!bang"
].join("\n");
const ignored = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", ignoreRules),
  file("debug.log"),
  file("important.log"),
  file("src/debug.log"),
  file("build/drop.js"),
  file("build/keep.js"),
  file("nested/drop1.js"),
  file("nested/a/b/drop2.js"),
  file("nested/a/b/drop20.js"),
  file("root-only.txt"),
  file("nested/root-only.txt"),
  file("file-2.tmp"),
  file("file-a.tmp"),
  file("file-7.cache"),
  file("file-a.cache"),
  file("axxb.txt"),
  file("a/x/b.txt"),
  file("#notes"),
  file("!bang")
]));
assert.deepEqual(ignored.files.map((entry) => entry.path), [
  ".nuriteoignore",
  "a/x/b.txt",
  "build/keep.js",
  "file-a.cache",
  "file-a.tmp",
  "important.log",
  "nested/a/b/drop20.js",
  "nested/root-only.txt"
]);

const parentStillExcluded = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", "dist/\n!dist/keep.js\n"),
  file("dist/keep.js"),
  file("dist/drop.js")
]));
assert.deepEqual(parentStillExcluded.files.map((entry) => entry.path), [".nuriteoignore"]);
const parentReincluded = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", "dist/\n!dist/\ndist/*\n!dist/keep.js\n"),
  file("dist/keep.js"),
  file("dist/drop.js")
]));
assert.deepEqual(parentReincluded.files.map((entry) => entry.path), [".nuriteoignore", "dist/keep.js"]);

const immutableExclusions = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", ["!.env", "!.env.local", "!.git/", "!node_modules/", "!run.pid", "!server.lock"].join("\n")),
  file(".git/config"),
  file("vendor/node_modules/index.js"),
  file(".pnpm-store/index"),
  file(".yarn/cache/package.zip"),
  file("vendor/.yarn/cache/package.zip"),
  file(".nuriteo/cache/state"),
  file(".nuriteo/runtime/state"),
  file(".nuriteo/temp/state"),
  file(".nuriteo/tmp/state"),
  file("run.pid"),
  file("run.sock"),
  file("server.lock"),
  file("runtime.lock"),
  file(".env"),
  file("config/.env.local"),
  file(".env.example"),
  file("config/.env.sample"),
  file(".env.template"),
  file("yarn.lock"),
  file("Cargo.lock")
]));
assert.deepEqual(immutableExclusions.files.map((entry) => entry.path), [
  ".env.example",
  ".env.template",
  ".nuriteoignore",
  "Cargo.lock",
  "config/.env.sample",
  "yarn.lock"
]);

const ignoreEverything = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", "*\n"),
  file("source.ts")
]));
assert.deepEqual(ignoreEverything.files.map((entry) => entry.path), [".nuriteoignore"]);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(".nuriteoignore", Uint8Array.of(0xff), "text")])),
  "INVALID_IGNORE_FILE"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(".nuriteoignore", "../escape\n")])),
  "INVALID_IGNORE_PATTERN"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(".nuriteoignore", "file-[z-a].tmp\n")])),
  "INVALID_IGNORE_PATTERN"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(".nuriteoignore", `${"*a".repeat(33)}\n`)])),
  "INVALID_IGNORE_PATTERN"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([file(".nuriteoignore", `${"a".repeat(1_025)}\n`)])),
  "INVALID_IGNORE_PATTERN"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([
    file(".nuriteoignore", Array.from({ length: 4_097 }, (_, index) => `file-${index}`).join("\n"))
  ])),
  "INVALID_IGNORE_FILE"
);
expectValidationError(
  () => validateProjectBundleV1Projection(projection([
    file(".nuriteoignore", Array.from({ length: 4_096 }, (_, index) => `ignored-${index}`).join("\n")),
    ...maxFiles
  ])),
  "INVALID_IGNORE_FILE"
);

const ignoredHuge = validateProjectBundleV1Projection(projection([
  file(".nuriteoignore", "node_modules/\n"),
  file("node_modules/huge.bin", new Uint8Array(16 * MEBIBYTE + 1), "binary"),
  file("source.ts", "ok")
]));
assert.deepEqual(ignoredHuge.files.map((entry) => entry.path), [".nuriteoignore", "source.ts"]);

expectValidationError(() => validateProjectBundleV1Projection({
  projectId,
  storageScopeId,
  files: new Array(100_001)
}), "FILE_COUNT_EXCEEDED");
if (typeof SharedArrayBuffer !== "undefined") {
  expectValidationError(
    () => validateProjectBundleV1Projection(projection([
      file("shared.bin", new Uint8Array(new SharedArrayBuffer(1)), "binary")
    ])),
    "INVALID_INPUT"
  );
}

const mutable = Uint8Array.of(1, 2, 3);
const detached = validateProjectBundleV1Projection(projection([file("data.bin", mutable, "binary")]));
mutable[0] = 99;
assert.deepEqual([...detached.files[0]!.bytes], [1, 2, 3]);
assert.throws(() => {
  (detached.files[0] as { path: string }).path = "../mutated";
}, TypeError);

const randomFiles = Array.from({ length: 128 }, (_, index) =>
  file(`src/group-${index % 7}/file-${index.toString(36)}.ts`, Uint8Array.of(index))
);
const shuffled = seededShuffle(randomFiles, 0xc0ffee);
const firstProjection = validateProjectBundleV1Projection(projection(randomFiles));
const secondProjection = validateProjectBundleV1Projection(projection(shuffled));
assert.deepEqual(secondProjection.files.map((entry) => entry.path), firstProjection.files.map((entry) => entry.path));
assert.deepEqual(
  (await writeValidatedProjectBundleV1(secondProjection)).bytes,
  (await writeValidatedProjectBundleV1(firstProjection)).bytes
);

let accessorInvoked = false;
const accessorFiles: ProjectBundleV1SourceFile[] = [file("ok")];
Object.defineProperty(accessorFiles, "0", {
  configurable: true,
  get() {
    accessorInvoked = true;
    return file("leaked");
  }
});
expectValidationError(
  () => validateProjectBundleV1Projection({ projectId, storageScopeId, files: accessorFiles }),
  "INVALID_INPUT"
);
assert.equal(accessorInvoked, false, "file array accessors must be rejected without invocation");
const extraPropertyFiles = [file("ok")] as ProjectBundleV1SourceFile[] & { credential?: string };
extraPropertyFiles.credential = "do-not-copy";
expectValidationError(
  () => validateProjectBundleV1Projection({ projectId, storageScopeId, files: extraPropertyFiles }),
  "INVALID_INPUT"
);
let byteGetterInvoked = false;
const accessorFile = {
  path: "ok",
  kind: "text",
  executable: false,
  get bytes(): Uint8Array {
    byteGetterInvoked = true;
    return Uint8Array.of();
  }
};
expectValidationError(
  () => validateProjectBundleV1Projection({ projectId, storageScopeId, files: [accessorFile] }),
  "INVALID_INPUT"
);
assert.equal(byteGetterInvoked, false, "file field accessors must be rejected without invocation");

for (const malicious of maliciousInputs()) {
  expectValidationError(() => validateProjectBundleV1Projection(malicious), "INVALID_INPUT");
}

function file(
  path: string,
  contents: string | Uint8Array = "",
  kind: "text" | "binary" = "text",
  executable = false
): ProjectBundleV1SourceFile {
  return { path, kind, executable, bytes: typeof contents === "string" ? encoder.encode(contents) : contents };
}

function projection(files: readonly ProjectBundleV1SourceFile[]): RawProjectBundleV1Projection {
  return { projectId, storageScopeId, files };
}

function expectValidationError(action: () => unknown, code: ProjectBundleValidationErrorCode): void {
  assert.throws(action, (error: unknown) => error instanceof ProjectBundleValidationError && error.code === code);
}

function seededShuffle<T>(values: readonly T[], initialState: number): T[] {
  const shuffled = [...values];
  let state = initialState >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

function maliciousInputs(): unknown[] {
  const extraSource = { ...projection([file("ok")]), credential: "do-not-copy" };
  const symbolSource = { ...projection([file("ok")]), [Symbol("secret")]: true };
  const extraFile = projection([{ ...file("ok"), cacheKey: "hidden" } as ProjectBundleV1SourceFile]);
  const invalidProject = { ...projection([file("ok")]), projectId: "not-a-uuid" };
  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.assign(inherited, projection([file("ok")]));
  return [null, [], extraSource, symbolSource, extraFile, invalidProject, inherited];
}
