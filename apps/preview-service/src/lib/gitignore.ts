type GitignoreRule = {
  descendantPattern: RegExp;
  directoryOnly: boolean;
  exactPattern: RegExp;
  ignored: boolean;
};

export type GitignoreMatcher = {
  isIgnored: (relativePath: string, isDirectory: boolean) => boolean;
};

export function createGitignoreMatcher(source: string): GitignoreMatcher {
  const rules = source
    .split(/\r?\n/u)
    .map(parseRule)
    .filter((rule): rule is GitignoreRule => rule !== null);

  return {
    isIgnored(relativePath, isDirectory) {
      const normalizedPath = normalizeRelativePath(relativePath);
      if (!normalizedPath || normalizedPath === ".gitignore") return false;

      let ignored = false;
      for (const rule of rules) {
        const matchesExactPath = rule.exactPattern.test(normalizedPath);
        const matchesDirectoryContents = rule.descendantPattern.test(normalizedPath);
        const matches = matchesDirectoryContents || (matchesExactPath && (!rule.directoryOnly || isDirectory));
        if (matches) ignored = rule.ignored;
      }
      return ignored;
    }
  };
}

function parseRule(rawLine: string): GitignoreRule | null {
  let pattern = rawLine.trim();
  if (!pattern || pattern.startsWith("#")) return null;

  let ignored = true;
  if (pattern.startsWith("!")) {
    ignored = false;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  }

  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  if (!pattern) return null;

  const hasPathSeparator = pattern.includes("/");
  const prefix = anchored || hasPathSeparator ? "^" : "(?:^|/)";
  const body = globToRegex(pattern);

  return {
    exactPattern: new RegExp(`${prefix}${body}$`, "u"),
    descendantPattern: new RegExp(`${prefix}${body}/.+$`, "u"),
    directoryOnly,
    ignored
  };
}

function globToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      const nextCharacter = pattern[index + 1];
      if (nextCharacter === "*") {
        const characterAfterGlobstar = pattern[index + 2];
        if (characterAfterGlobstar === "/") {
          output += "(?:.*/)?";
          index += 2;
        } else {
          output += ".*";
          index += 1;
        }
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegex(character || "");
  }
  return output;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}
