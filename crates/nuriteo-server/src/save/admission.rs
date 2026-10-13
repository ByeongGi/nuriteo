use regex::Regex;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use super::verifier::VerificationError;

pub(super) const CONTRACT_JSON: &str =
    include_str!("../../../../compat/project-bundle-admission-v1.json");
pub(super) const ROOT_IGNORE_PATH: &str = ".nuriteoignore";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contract {
    contract: String,
    bundle_format: String,
    path_normalization: String,
    ignore_semantics: String,
    path_rules: serde_json::Value,
    ignore_rules: serde_json::Value,
    defaults: Limits,
    configurable_bounds: serde_json::Value,
    ignore_bounds: IgnoreBounds,
    client_workspace_scan: serde_json::Value,
    system_exclusions: SystemExclusions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Limits {
    pub max_file_bytes: u64,
    pub max_logical_bytes: u64,
    pub max_files: usize,
    pub max_depth: usize,
    pub max_path_bytes: usize,
    pub max_segment_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IgnoreBounds {
    max_patterns: usize,
    max_pattern_bytes: usize,
    max_wildcards_per_pattern: usize,
    max_match_evaluations: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SystemExclusions {
    directory_names: Vec<String>,
    directory_paths: Vec<String>,
    ephemeral_suffixes: Vec<String>,
    ephemeral_names: Vec<String>,
    source_lockfile_names: Vec<String>,
    credential_rule: String,
}

#[derive(Debug)]
pub(super) struct AdmissionContract {
    pub limits: Limits,
    ignore: IgnoreBounds,
    exclusions: SystemExclusions,
}

impl AdmissionContract {
    pub fn load() -> Result<Self, VerificationError> {
        let contract: Contract = serde_json::from_str(CONTRACT_JSON)
            .map_err(|_| VerificationError::InvariantViolation)?;
        if contract.contract != "project-bundle-admission-v1"
            || contract.bundle_format != "project-bundle-v1"
            || contract.path_normalization != "Unicode NFC"
            || contract.ignore_semantics != "nuriteo-ignore-v1"
            || contract.path_rules
                != serde_json::json!({
                    "syntax":"relative-posix","rejectAbsolute":true,"rejectBackslash":true,
                    "rejectEmptyDotDotDotSegments":true,"rejectControlsAndUnpairedSurrogates":true,
                    "rejectPostNormalizationDuplicates":true,"measure":"UTF-8 bytes"
                })
            || contract.ignore_rules
                != serde_json::json!({
                    "rootFile":".nuriteoignore","encoding":"UTF-8-strict",
                    "orderedLastMatchWins":true,"excludedParentMustBeReincluded":true,
                    "syntax":["blank-and-hash-comments","backslash-escape","root-anchor-slash",
                        "directory-trailing-slash","negation-bang","wildcard-star-question-double-star",
                        "character-class-and-range"]
                })
            || contract.configurable_bounds
                != serde_json::json!({
                    "maxFileBytes":{"min":1,"max":16777216},
                    "maxLogicalBytes":{"min":16777216,"max":268435456},
                    "maxFiles":{"min":1,"max":2500},"maxDepth":{"min":8,"max":64},
                    "maxPathBytes":{"min":256,"max":1024}
                })
            || contract.client_workspace_scan != serde_json::json!({"maxFiles":100000})
            || contract.system_exclusions.credential_rule
                != ".env and .env.* except .env.example/.sample/.template"
        {
            return Err(VerificationError::InvariantViolation);
        }
        Ok(Self {
            limits: contract.defaults,
            ignore: contract.ignore_bounds,
            exclusions: contract.system_exclusions,
        })
    }

    pub fn validate_path(&self, path: &str) -> Result<(), VerificationError> {
        if path.is_empty()
            || path.starts_with('/')
            || (path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && path.as_bytes().get(1) == Some(&b':')
                && path.as_bytes().get(2) == Some(&b'/'))
            || path.contains('\\')
            || has_contract_control(path)
            || path.nfc().collect::<String>() != path
            || path.len() > self.limits.max_path_bytes
        {
            return Err(VerificationError::InvalidArchive);
        }
        let segments = path.split('/').collect::<Vec<_>>();
        if segments.len() > self.limits.max_depth
            || segments.iter().any(|segment| {
                segment.is_empty()
                    || *segment == "."
                    || *segment == ".."
                    || segment.len() > self.limits.max_segment_bytes
            })
        {
            return Err(VerificationError::InvalidArchive);
        }
        Ok(())
    }

    pub fn validate_admitted_paths(
        &self,
        paths: &[String],
        ignore_source: Option<&[u8]>,
    ) -> Result<(), VerificationError> {
        let rules = self.parse_ignore(ignore_source)?;
        let candidates = paths.iter().try_fold(0_usize, |total, path| {
            total
                .checked_add(path.split('/').count())
                .ok_or(VerificationError::InvalidArchive)
        })?;
        if rules.len().saturating_mul(candidates) > self.ignore.max_match_evaluations {
            return Err(VerificationError::InvalidArchive);
        }
        for path in paths {
            if path != ROOT_IGNORE_PATH
                && (self.is_system_excluded(path) || is_ignored(path, &rules))
            {
                return Err(VerificationError::InvalidArchive);
            }
        }
        Ok(())
    }

    pub(super) fn admitted_paths(
        &self,
        paths: &[String],
        ignore_source: Option<&[u8]>,
    ) -> Result<Vec<bool>, VerificationError> {
        let rules = self.parse_ignore(ignore_source)?;
        let candidates = paths.iter().try_fold(0_usize, |total, path| {
            total
                .checked_add(path.split('/').count())
                .ok_or(VerificationError::InvalidArchive)
        })?;
        if rules.len().saturating_mul(candidates) > self.ignore.max_match_evaluations {
            return Err(VerificationError::InvalidArchive);
        }
        paths
            .iter()
            .map(|path| {
                self.validate_path(path)?;
                Ok(path == ROOT_IGNORE_PATH
                    || (!self.is_system_excluded(path) && !is_ignored(path, &rules)))
            })
            .collect()
    }

    fn parse_ignore(&self, source: Option<&[u8]>) -> Result<Vec<IgnoreRule>, VerificationError> {
        let Some(source) = source else {
            return Ok(Vec::new());
        };
        let text = std::str::from_utf8(source).map_err(|_| VerificationError::InvalidArchive)?;
        let mut rules = Vec::new();
        for segment in text.split_inclusive('\n') {
            let raw = segment.strip_suffix('\n').unwrap_or(segment);
            let raw = if segment.ends_with('\n') {
                raw.strip_suffix('\r').unwrap_or(raw)
            } else {
                raw
            };
            if let Some(rule) = self.parse_ignore_line(raw)? {
                rules.push(rule);
                if rules.len() > self.ignore.max_patterns {
                    return Err(VerificationError::InvalidArchive);
                }
            }
        }
        Ok(rules)
    }

    fn parse_ignore_line(&self, raw: &str) -> Result<Option<IgnoreRule>, VerificationError> {
        let line = trim_unescaped_spaces(raw);
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }
        if has_contract_control(line) || line.len() > self.ignore.max_pattern_bytes {
            return Err(VerificationError::InvalidArchive);
        }
        let mut ignored = true;
        let mut pattern = line;
        if let Some(rest) = pattern.strip_prefix('!') {
            ignored = false;
            pattern = rest;
        } else if pattern.starts_with("\\#") || pattern.starts_with("\\!") {
            pattern = &pattern[1..];
        }
        if pattern.is_empty() {
            return Err(VerificationError::InvalidArchive);
        }
        let directory_only = ends_with_unescaped_slash(pattern);
        if directory_only {
            pattern = &pattern[..pattern.len() - 1];
        }
        let anchored = pattern.starts_with('/');
        if anchored {
            pattern = &pattern[1..];
        }
        if pattern.is_empty()
            || pattern
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || pattern.nfc().collect::<String>() != pattern
        {
            return Err(VerificationError::InvalidArchive);
        }
        let (glob, wildcards) = glob_regex(pattern)?;
        if wildcards > self.ignore.max_wildcards_per_pattern {
            return Err(VerificationError::InvalidArchive);
        }
        let prefix = if anchored || pattern.contains('/') {
            "^"
        } else {
            "(?:^|/)"
        };
        let matcher = Regex::new(&format!("{prefix}{glob}$"))
            .map_err(|_| VerificationError::InvalidArchive)?;
        Ok(Some(IgnoreRule {
            ignored,
            directory_only,
            matcher,
        }))
    }

    fn is_system_excluded(&self, path: &str) -> bool {
        let segments = path.split('/').collect::<Vec<_>>();
        if segments.iter().any(|segment| {
            self.exclusions
                .directory_names
                .iter()
                .any(|name| name == segment)
        }) {
            return true;
        }
        let directory = segments[..segments.len().saturating_sub(1)].join("/");
        if self.exclusions.directory_paths.iter().any(|excluded| {
            directory == *excluded
                || directory.starts_with(&format!("{excluded}/"))
                || directory.contains(&format!("/{excluded}/"))
                || directory.ends_with(&format!("/{excluded}"))
        }) {
            return true;
        }
        let basename = segments.last().copied().unwrap_or_default();
        if basename == ".env"
            || (basename.starts_with(".env.")
                && !matches!(basename, ".env.example" | ".env.sample" | ".env.template"))
        {
            return true;
        }
        if self
            .exclusions
            .source_lockfile_names
            .iter()
            .any(|name| name == basename)
        {
            return false;
        }
        self.exclusions
            .ephemeral_names
            .iter()
            .any(|name| name == basename)
            || self
                .exclusions
                .ephemeral_suffixes
                .iter()
                .any(|suffix| basename.ends_with(suffix))
    }
}

fn has_contract_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character as u32, 0..=0x1f | 0x7f))
}

#[derive(Debug)]
struct IgnoreRule {
    ignored: bool,
    directory_only: bool,
    matcher: Regex,
}

fn is_ignored(path: &str, rules: &[IgnoreRule]) -> bool {
    let segments = path.split('/').collect::<Vec<_>>();
    for depth in 1..segments.len() {
        if apply_rules(&segments[..depth].join("/"), true, rules) {
            return true;
        }
    }
    apply_rules(path, false, rules)
}

fn apply_rules(path: &str, directory: bool, rules: &[IgnoreRule]) -> bool {
    let mut ignored = false;
    for rule in rules {
        if (!rule.directory_only || directory) && rule.matcher.is_match(path) {
            ignored = rule.ignored;
        }
    }
    ignored
}

fn trim_unescaped_spaces(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1] == b' ' {
        let mut slashes = 0;
        let mut index = end - 1;
        while index > 0 && bytes[index - 1] == b'\\' {
            slashes += 1;
            index -= 1;
        }
        if slashes % 2 == 1 {
            break;
        }
        end -= 1;
    }
    &value[..end]
}

fn ends_with_unescaped_slash(value: &str) -> bool {
    if !value.ends_with('/') {
        return false;
    }
    let bytes = value.as_bytes();
    let mut slashes = 0;
    let mut index = bytes.len() - 1;
    while index > 0 && bytes[index - 1] == b'\\' {
        slashes += 1;
        index -= 1;
    }
    slashes % 2 == 0
}

fn glob_regex(pattern: &str) -> Result<(String, usize), VerificationError> {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut wildcards = 0;
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\\' => {
                index += 1;
                let ch = *chars.get(index).ok_or(VerificationError::InvalidArchive)?;
                output.push_str(&regex::escape(&ch.to_string()));
            }
            '*' => {
                wildcards += 1;
                if chars.get(index + 1) == Some(&'*') {
                    let starts = index == 0 || chars[index - 1] == '/';
                    while chars.get(index + 1) == Some(&'*') {
                        index += 1;
                    }
                    let ends = index + 1 == chars.len() || chars.get(index + 1) == Some(&'/');
                    if !starts || !ends {
                        output.push_str("[^/]*");
                    } else if chars.get(index + 1) == Some(&'/') {
                        output.push_str("(?:.*/)?");
                        index += 1;
                    } else {
                        output.push_str(".*");
                    }
                } else {
                    output.push_str("[^/]*");
                }
            }
            '?' => {
                wildcards += 1;
                output.push_str("[^/]");
            }
            '[' => {
                if let Some((class, end)) = character_class(&chars, index)? {
                    wildcards += 1;
                    output.push_str(&class);
                    index = end;
                } else {
                    output.push_str("\\[");
                }
            }
            ch => output.push_str(&regex::escape(&ch.to_string())),
        }
        index += 1;
    }
    Ok((output, wildcards))
}

fn character_class(
    chars: &[char],
    start: usize,
) -> Result<Option<(String, usize)>, VerificationError> {
    let mut end = start + 1;
    let mut escaped = false;
    while end < chars.len() {
        if !escaped && chars[end] == ']' && end > start + 1 {
            break;
        }
        escaped = !escaped && chars[end] == '\\';
        end += 1;
    }
    if end >= chars.len() {
        return Ok(None);
    }
    let mut body = chars[start + 1..end].to_vec();
    let negated = body.first().is_some_and(|ch| matches!(ch, '!' | '^'));
    if negated {
        body.remove(0);
    }
    if body.is_empty() || body.contains(&'/') {
        return Err(VerificationError::InvalidArchive);
    }
    let mut rendered = String::from("[");
    if negated {
        rendered.push('^');
    }
    let mut index = 0;
    while index < body.len() {
        let character = body[index];
        if character == '\\' {
            index += 1;
            let literal = *body.get(index).ok_or(VerificationError::InvalidArchive)?;
            push_class_literal(&mut rendered, literal);
        } else if character == '-' && index > 0 && index + 1 < body.len() {
            rendered.push('-');
        } else {
            push_class_literal(&mut rendered, character);
        }
        index += 1;
    }
    rendered.push(']');
    Regex::new(&rendered).map_err(|_| VerificationError::InvalidArchive)?;
    Ok(Some((rendered, end)))
}

fn push_class_literal(target: &mut String, character: char) {
    if matches!(character, '\\' | ']' | '[' | '^' | '-') {
        target.push('\\');
    }
    target.push(character);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_defaults_are_the_versioned_product_contract() {
        let contract = AdmissionContract::load().unwrap();
        assert_eq!(contract.limits.max_file_bytes, 16 * 1024 * 1024);
        assert_eq!(contract.limits.max_logical_bytes, 128 * 1024 * 1024);
        assert_eq!(contract.limits.max_files, 2_500);
        assert_eq!(contract.limits.max_depth, 32);
        assert_eq!(contract.limits.max_path_bytes, 512);
        assert_eq!(contract.limits.max_segment_bytes, 255);
    }

    #[test]
    fn malformed_ignore_classes_fail_closed() {
        let contract = AdmissionContract::load().unwrap();
        assert_eq!(
            contract.parse_ignore(Some(b"[z-a]\n")).unwrap_err(),
            VerificationError::InvalidArchive
        );
    }

    #[test]
    fn path_and_ignore_edges_match_the_web_contract() {
        let contract = AdmissionContract::load().unwrap();
        assert!(contract.validate_path("1:file").is_ok());
        assert!(contract.validate_path("a:b").is_ok());
        assert_eq!(
            contract.validate_path("C:/absolute").unwrap_err(),
            VerificationError::InvalidArchive
        );
        assert!(contract.validate_path("unicode\u{85}control-name").is_ok());
        assert_eq!(
            contract.parse_ignore(Some(b"valid\r")).unwrap_err(),
            VerificationError::InvalidArchive
        );
        assert!(contract.parse_ignore(Some(b"valid\r\n")).is_ok());
        assert!(
            contract
                .parse_ignore(Some(b"[\\-]\n[\\]]\n[\\\\]\n"))
                .is_ok()
        );
    }
}
