import type {
  ProjectBundleV1SourceFile,
  ValidatedProjectBundleV1Projection
} from "./project-bundle-v1.ts";

const MEBIBYTE = 1024 * 1024;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROOT_IGNORE_PATH = ".nuriteoignore";
const MAX_IGNORE_PATTERNS = 4_096;
const MAX_IGNORE_PATTERN_BYTES = 1_024;
const MAX_IGNORE_WILDCARDS = 32;
const MAX_IGNORE_MATCH_EVALUATIONS = 10_000_000;
const MAX_SCANNED_FILES = 100_000;
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 16 * MEBIBYTE,
  maxLogicalBytes: 128 * MEBIBYTE,
  maxFiles: 2_500,
  maxDepth: 32,
  maxPathBytes: 512,
  maxSegmentBytes: 255
});
const CONFIGURABLE_BOUNDS = Object.freeze({
  maxFileBytes: Object.freeze({ min: 1, max: 16 * MEBIBYTE }),
  maxLogicalBytes: Object.freeze({ min: 16 * MEBIBYTE, max: 256 * MEBIBYTE }),
  maxFiles: Object.freeze({ min: 1, max: 2_500 }),
  maxDepth: Object.freeze({ min: 8, max: 64 }),
  maxPathBytes: Object.freeze({ min: 256, max: 1_024 })
});
const SYSTEM_EXCLUSIONS = Object.freeze({
  directoryNames: Object.freeze([".git", "node_modules", ".pnpm-store"] as const),
  directoryPaths: Object.freeze([
    ".yarn/cache",
    ".nuriteo/cache",
    ".nuriteo/runtime",
    ".nuriteo/temp",
    ".nuriteo/tmp"
  ] as const),
  ephemeralSuffixes: Object.freeze([".pid", ".sock", ".socket", ".lock"] as const),
  ephemeralNames: Object.freeze([".lock", "runtime.lock"] as const),
  sourceLockfileNames: Object.freeze([
    "bun.lock",
    "Cargo.lock",
    "composer.lock",
    "deno.lock",
    "Gemfile.lock",
    "Pipfile.lock",
    "poetry.lock",
    "yarn.lock"
  ] as const),
  credentialRule: ".env and .env.* except .env.example/.sample/.template"
});

export const PROJECT_BUNDLE_ADMISSION_CONTRACT = Object.freeze({
  contract: "project-bundle-admission-v1",
  bundleFormat: "project-bundle-v1",
  pathNormalization: "Unicode NFC",
  ignoreSemantics: "nuriteo-ignore-v1",
  pathRules: Object.freeze({
    syntax: "relative-posix",
    rejectAbsolute: true,
    rejectBackslash: true,
    rejectEmptyDotDotDotSegments: true,
    rejectControlsAndUnpairedSurrogates: true,
    rejectPostNormalizationDuplicates: true,
    measure: "UTF-8 bytes"
  }),
  ignoreRules: Object.freeze({
    rootFile: ROOT_IGNORE_PATH,
    encoding: "UTF-8-strict",
    orderedLastMatchWins: true,
    excludedParentMustBeReincluded: true,
    syntax: Object.freeze([
      "blank-and-hash-comments",
      "backslash-escape",
      "root-anchor-slash",
      "directory-trailing-slash",
      "negation-bang",
      "wildcard-star-question-double-star",
      "character-class-and-range"
    ] as const)
  }),
  defaults: DEFAULT_LIMITS,
  configurableBounds: CONFIGURABLE_BOUNDS,
  ignoreBounds: Object.freeze({
    maxPatterns: MAX_IGNORE_PATTERNS,
    maxPatternBytes: MAX_IGNORE_PATTERN_BYTES,
    maxWildcardsPerPattern: MAX_IGNORE_WILDCARDS,
    maxMatchEvaluations: MAX_IGNORE_MATCH_EVALUATIONS
  }),
  clientWorkspaceScan: Object.freeze({ maxFiles: MAX_SCANNED_FILES }),
  systemExclusions: SYSTEM_EXCLUSIONS
});

export type ProjectBundleValidationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LIMITS"
  | "INVALID_PATH"
  | "DUPLICATE_PATH"
  | "INVALID_IGNORE_FILE"
  | "INVALID_IGNORE_PATTERN"
  | "FILE_TOO_LARGE"
  | "LOGICAL_SIZE_EXCEEDED"
  | "FILE_COUNT_EXCEEDED";

export class ProjectBundleValidationError extends Error {
  readonly code: ProjectBundleValidationErrorCode;
  readonly fileIndex: number | undefined;

  constructor(code: ProjectBundleValidationErrorCode, message: string, fileIndex?: number) {
    super(message);
    this.name = "ProjectBundleValidationError";
    this.code = code;
    this.fileIndex = fileIndex;
  }
}

export interface RawProjectBundleV1Projection {
  readonly projectId: string;
  readonly storageScopeId: string;
  readonly files: readonly ProjectBundleV1SourceFile[];
}

export interface ProjectBundleAdmissionLimits {
  readonly maxFileBytes: number;
  readonly maxLogicalBytes: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
}

export type ProjectBundleAdmissionLimitOverrides = Partial<ProjectBundleAdmissionLimits>;

interface NormalizedFile extends ProjectBundleV1SourceFile {
  readonly sourceIndex: number;
}

interface IgnoreRule {
  readonly ignored: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: RegExp;
}

export function validateProjectBundleV1Projection(
  input: unknown,
  limitOverrides: ProjectBundleAdmissionLimitOverrides = {}
): ValidatedProjectBundleV1Projection {
  const raw = parseProjection(input);
  const limits = resolveLimits(limitOverrides);
  const normalized = normalizeFiles(raw.files, limits);
  const ignoreRules = parseRootIgnore(normalized);
  const admitted: ProjectBundleV1SourceFile[] = [];
  let logicalBytes = 0;

  for (const file of normalized) {
    const alwaysIncluded = file.path === ROOT_IGNORE_PATH;
    if (!alwaysIncluded && (isSystemExcluded(file.path) || isIgnored(file.path, ignoreRules))) continue;
    if (file.bytes.byteLength > limits.maxFileBytes) {
      throw new ProjectBundleValidationError(
        "FILE_TOO_LARGE",
        "A Project Bundle file exceeds the configured byte limit.",
        file.sourceIndex
      );
    }
    if (admitted.length >= limits.maxFiles) {
      throw new ProjectBundleValidationError("FILE_COUNT_EXCEEDED", "Project Bundle file count exceeds the configured limit.");
    }
    logicalBytes = checkedLogicalAdd(logicalBytes, file.bytes.byteLength, limits.maxLogicalBytes);
    admitted.push(Object.freeze({
      path: file.path,
      kind: file.kind,
      executable: file.executable,
      bytes: Uint8Array.from(file.bytes)
    }));
  }

  return Object.freeze({
    projectId: raw.projectId,
    storageScopeId: raw.storageScopeId,
    files: Object.freeze(admitted)
  }) as ValidatedProjectBundleV1Projection;
}

function parseProjection(input: unknown): RawProjectBundleV1Projection {
  const record = requireExactDataObject(input, ["files", "projectId", "storageScopeId"], "INVALID_INPUT");
  if (
    typeof record.projectId !== "string"
    || typeof record.storageScopeId !== "string"
    || !UUID_V7.test(record.projectId)
    || !UUID_V7.test(record.storageScopeId)
    || !Array.isArray(record.files)
  ) {
    throw new ProjectBundleValidationError("INVALID_INPUT", "Project Bundle projection is malformed.");
  }
  const fileInputs = record.files;
  if (fileInputs.length > MAX_SCANNED_FILES) {
    throw new ProjectBundleValidationError("FILE_COUNT_EXCEEDED", "Workspace projection exceeds the bounded scan limit.");
  }
  const arrayKeys = Reflect.ownKeys(fileInputs);
  const exactArrayKeys = arrayKeys.length === fileInputs.length + 1
    && arrayKeys.every((key) => key === "length" || (
      typeof key === "string"
      && Number.isSafeInteger(Number(key))
      && Number(key) >= 0
      && Number(key) < fileInputs.length
      && String(Number(key)) === key
    ));
  if (!exactArrayKeys) {
    throw new ProjectBundleValidationError("INVALID_INPUT", "Project Bundle files array has unexpected properties.");
  }
  const files: ProjectBundleV1SourceFile[] = [];
  for (let index = 0; index < fileInputs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(fileInputs, index);
    if (!descriptor || !("value" in descriptor)) {
      throw new ProjectBundleValidationError("INVALID_INPUT", "Project Bundle files must be a dense data array.");
    }
    files.push(parseFile(descriptor.value, index));
  }
  return { projectId: record.projectId, storageScopeId: record.storageScopeId, files };
}

function parseFile(input: unknown, index: number): ProjectBundleV1SourceFile {
  const record = requireExactDataObject(input, ["bytes", "executable", "kind", "path"], "INVALID_INPUT", index);
  const sharedBytes = typeof SharedArrayBuffer !== "undefined"
    && record.bytes instanceof Uint8Array
    && record.bytes.buffer instanceof SharedArrayBuffer;
  if (
    typeof record.path !== "string"
    || (record.kind !== "text" && record.kind !== "binary")
    || typeof record.executable !== "boolean"
    || !(record.bytes instanceof Uint8Array)
    || sharedBytes
  ) {
    throw new ProjectBundleValidationError("INVALID_INPUT", "Project Bundle file projection is malformed.", index);
  }
  return {
    path: record.path,
    kind: record.kind,
    executable: record.executable,
    bytes: record.bytes
  };
}

function requireExactDataObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ProjectBundleValidationErrorCode,
  fileIndex?: number
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProjectBundleValidationError(code, "Project Bundle input object is malformed.", fileIndex);
  }
  const prototype = Object.getPrototypeOf(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(input);
  const keys = ownKeys.filter((key): key is string => typeof key === "string").sort();
  const exactKeys = ownKeys.length === expectedKeys.length
    && keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
  const dataOnly = Object.values(descriptors).every((descriptor) => "value" in descriptor);
  if ((prototype !== Object.prototype && prototype !== null) || !exactKeys || !dataOnly) {
    throw new ProjectBundleValidationError(code, "Project Bundle input object is malformed.", fileIndex);
  }
  return input as Record<string, unknown>;
}

function resolveLimits(overrides: ProjectBundleAdmissionLimitOverrides): ProjectBundleAdmissionLimits {
  const record = requireExactLimitObject(overrides);
  const defaults = DEFAULT_LIMITS;
  const resolved = {
    maxFileBytes: record.maxFileBytes ?? defaults.maxFileBytes,
    maxLogicalBytes: record.maxLogicalBytes ?? defaults.maxLogicalBytes,
    maxFiles: record.maxFiles ?? defaults.maxFiles,
    maxDepth: record.maxDepth ?? defaults.maxDepth,
    maxPathBytes: record.maxPathBytes ?? defaults.maxPathBytes
  };
  const bounds = CONFIGURABLE_BOUNDS;
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const value = resolved[key];
    const { min, max } = bounds[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ProjectBundleValidationError("INVALID_LIMITS", "Project Bundle admission limits are outside product bounds.");
    }
  }
  return resolved;
}

function requireExactLimitObject(input: ProjectBundleAdmissionLimitOverrides): ProjectBundleAdmissionLimitOverrides {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProjectBundleValidationError("INVALID_LIMITS", "Project Bundle admission limits are malformed.");
  }
  const allowed = ["maxDepth", "maxFileBytes", "maxFiles", "maxLogicalBytes", "maxPathBytes"];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const prototype = Object.getPrototypeOf(input);
  const ownKeys = Reflect.ownKeys(input);
  const valid = (prototype === Object.prototype || prototype === null)
    && ownKeys.every((key) => typeof key === "string" && allowed.includes(key))
    && Object.values(descriptors).every((descriptor) => "value" in descriptor);
  if (!valid) throw new ProjectBundleValidationError("INVALID_LIMITS", "Project Bundle admission limits are malformed.");
  return input;
}

function normalizeFiles(files: readonly ProjectBundleV1SourceFile[], limits: ProjectBundleAdmissionLimits): NormalizedFile[] {
  const normalized = files.map((file, sourceIndex) => ({
    ...file,
    sourceIndex,
    path: normalizePath(file.path, limits, sourceIndex)
  }));
  normalized.sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.path === normalized[index]?.path) {
      throw new ProjectBundleValidationError("DUPLICATE_PATH", "Project Bundle paths collide after NFC normalization.");
    }
  }
  return normalized;
}

function normalizePath(path: string, limits: ProjectBundleAdmissionLimits, fileIndex: number): string {
  assertScalarString(path, "INVALID_PATH", fileIndex);
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.includes("\\")) {
    throw new ProjectBundleValidationError("INVALID_PATH", "Project Bundle path must be relative POSIX syntax.", fileIndex);
  }
  const normalized = path.normalize("NFC");
  const segments = normalized.split("/");
  const invalidSegment = segments.some((segment) => !segment || segment === "." || segment === "..");
  if (invalidSegment || segments.length > limits.maxDepth) {
    throw new ProjectBundleValidationError("INVALID_PATH", "Project Bundle path has invalid segments or depth.", fileIndex);
  }
  if (encoder.encode(normalized).byteLength > limits.maxPathBytes) {
    throw new ProjectBundleValidationError("INVALID_PATH", "Project Bundle path exceeds the configured byte limit.", fileIndex);
  }
  if (segments.some((segment) => encoder.encode(segment).byteLength > DEFAULT_LIMITS.maxSegmentBytes)) {
    throw new ProjectBundleValidationError("INVALID_PATH", "Project Bundle path segment exceeds the product byte limit.", fileIndex);
  }
  return normalized;
}

function assertScalarString(value: string, code: ProjectBundleValidationErrorCode, fileIndex?: number): void {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProjectBundleValidationError(code, "Project Bundle string is empty or contains a control character.", fileIndex);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new ProjectBundleValidationError(code, "Project Bundle string contains an unpaired surrogate.", fileIndex);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ProjectBundleValidationError(code, "Project Bundle string contains an unpaired surrogate.", fileIndex);
    }
  }
}

function parseRootIgnore(files: readonly NormalizedFile[]): readonly IgnoreRule[] {
  const ignoreFile = files.find((file) => file.path === ROOT_IGNORE_PATH);
  if (!ignoreFile) return [];
  if (ignoreFile.kind !== "text" || ignoreFile.bytes.byteLength > DEFAULT_LIMITS.maxFileBytes) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_FILE", "Root .nuriteoignore is not a bounded text file.", ignoreFile.sourceIndex);
  }
  let contents: string;
  try {
    contents = strictDecoder.decode(ignoreFile.bytes);
  } catch {
    throw new ProjectBundleValidationError("INVALID_IGNORE_FILE", "Root .nuriteoignore is not valid UTF-8.", ignoreFile.sourceIndex);
  }
  const rules: IgnoreRule[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const rule = parseIgnoreLine(line);
    if (!rule) continue;
    rules.push(rule);
    if (rules.length > MAX_IGNORE_PATTERNS) {
      throw new ProjectBundleValidationError("INVALID_IGNORE_FILE", "Root .nuriteoignore has too many patterns.", ignoreFile.sourceIndex);
    }
  }
  const candidatePaths = files.reduce((total, file) => total + file.path.split("/").length, 0);
  if (rules.length * candidatePaths > MAX_IGNORE_MATCH_EVALUATIONS) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_FILE", "Root .nuriteoignore exceeds the bounded match budget.", ignoreFile.sourceIndex);
  }
  return rules;
}

function parseIgnoreLine(rawLine: string): IgnoreRule | null {
  const line = trimUnescapedTrailingSpaces(rawLine);
  if (!line || line.startsWith("#")) return null;
  assertScalarString(line, "INVALID_IGNORE_PATTERN");
  if (encoder.encode(line).byteLength > MAX_IGNORE_PATTERN_BYTES) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore pattern is too long.");
  }

  let ignored = true;
  let pattern = line;
  if (pattern.startsWith("!")) {
    ignored = false;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (!pattern) throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore pattern is empty.");
  const directoryOnly = endsWithUnescapedSlash(pattern);
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (!pattern || pattern.split("/").some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore pattern has invalid segments.");
  }
  pattern = pattern.normalize("NFC");
  const containsSlash = pattern.includes("/");
  const glob = globToRegex(pattern);
  if (glob.wildcards > MAX_IGNORE_WILDCARDS) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore pattern has too many wildcards.");
  }
  const prefix = anchored || containsSlash ? "^" : "(?:^|/)";
  try {
    return { ignored, directoryOnly, matcher: new RegExp(`${prefix}${glob.source}$`, "u") };
  } catch {
    throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore pattern is malformed.");
  }
}

function trimUnescapedTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let slashes = 0;
    for (let index = end - 2; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function endsWithUnescapedSlash(value: string): boolean {
  if (!value.endsWith("/")) return false;
  let slashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 0;
}

function globToRegex(pattern: string): { source: string; wildcards: number } {
  let output = "";
  let wildcards = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore escape is incomplete.");
      output += escapeRegex(escaped);
      index += 1;
    } else if (character === "*") {
      wildcards += 1;
      if (pattern[index + 1] === "*") {
        const startsSegment = index === 0 || pattern[index - 1] === "/";
        while (pattern[index + 1] === "*") index += 1;
        const endsSegment = index + 1 === pattern.length || pattern[index + 1] === "/";
        if (!startsSegment || !endsSegment) {
          output += "[^/]*";
        } else if (pattern[index + 1] === "/") {
          output += "(?:.*/)?";
          index += 1;
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
    } else if (character === "?") {
      wildcards += 1;
      output += "[^/]";
    } else if (character === "[") {
      const characterClass = parseCharacterClass(pattern, index);
      if (characterClass) {
        wildcards += 1;
        output += characterClass.regex;
        index = characterClass.endIndex;
      } else {
        output += "\\[";
      }
    } else {
      output += escapeRegex(character);
    }
  }
  return { source: output, wildcards };
}

function parseCharacterClass(pattern: string, startIndex: number): { regex: string; endIndex: number } | null {
  let endIndex = startIndex + 1;
  let escaped = false;
  while (endIndex < pattern.length) {
    const character = pattern[endIndex]!;
    if (!escaped && character === "]" && endIndex > startIndex + 1) break;
    if (!escaped && character === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
    endIndex += 1;
  }
  if (endIndex >= pattern.length) return null;

  let body = pattern.slice(startIndex + 1, endIndex);
  let negated = false;
  if (body.startsWith("!") || body.startsWith("^")) {
    negated = true;
    body = body.slice(1);
  }
  if (!body || body.includes("/")) {
    throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore character class is invalid.");
  }
  let regexBody = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "\\") {
      const literal = body[index + 1];
      if (literal === undefined) throw new ProjectBundleValidationError("INVALID_IGNORE_PATTERN", "A .nuriteoignore character class escape is incomplete.");
      regexBody += escapeCharacterClass(literal);
      index += 1;
    } else if (character === "-" && index > 0 && index < body.length - 1) {
      regexBody += "-";
    } else {
      regexBody += escapeCharacterClass(character);
    }
  }
  return { regex: `[${negated ? "^" : ""}${regexBody}]`, endIndex };
}

function escapeCharacterClass(value: string): string {
  return value === "\\" || value === "]" || value === "[" || value === "^" || value === "-"
    ? `\\${value}`
    : value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isIgnored(path: string, rules: readonly IgnoreRule[]): boolean {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (applyIgnoreRules(segments.slice(0, depth).join("/"), true, rules)) return true;
  }
  return applyIgnoreRules(path, false, rules);
}

function applyIgnoreRules(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if ((!rule.directoryOnly || directory) && rule.matcher.test(path)) ignored = rule.ignored;
  }
  return ignored;
}

function isSystemExcluded(path: string): boolean {
  const segments = path.split("/");
  const directoryNames = SYSTEM_EXCLUSIONS.directoryNames;
  if (segments.some((segment) => directoryNames.some((name) => name === segment))) return true;
  const directories = segments.slice(0, -1);
  const directoryPath = directories.join("/");
  if (SYSTEM_EXCLUSIONS.directoryPaths.some((excluded) =>
    directoryPath === excluded
      || directoryPath.startsWith(`${excluded}/`)
      || directoryPath.includes(`/${excluded}/`)
      || directoryPath.endsWith(`/${excluded}`)
  )) return true;

  const basename = segments.at(-1)!;
  if (isCredentialEnvironmentFile(basename)) return true;
  if (SYSTEM_EXCLUSIONS.sourceLockfileNames.some((name) => name === basename)) return false;
  if (SYSTEM_EXCLUSIONS.ephemeralNames.some((name) => name === basename)) return true;
  return SYSTEM_EXCLUSIONS.ephemeralSuffixes.some((suffix) => basename.endsWith(suffix));
}

function isCredentialEnvironmentFile(basename: string): boolean {
  if (basename === ".env") return true;
  if (!basename.startsWith(".env.")) return false;
  return basename !== ".env.example" && basename !== ".env.sample" && basename !== ".env.template";
}

function checkedLogicalAdd(current: number, next: number, limit: number): number {
  const total = current + next;
  if (!Number.isSafeInteger(total) || total > limit) {
    throw new ProjectBundleValidationError("LOGICAL_SIZE_EXCEEDED", "Project Bundle logical bytes exceed the configured limit.");
  }
  return total;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
