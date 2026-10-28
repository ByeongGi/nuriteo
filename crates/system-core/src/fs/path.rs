use super::error::{FsError, FsResult};

/// Absolute path with `.` and `..` rejected.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AbsolutePath {
    parts: Vec<String>,
}

impl AbsolutePath {
    /// Splits an absolute path into directory names.
    ///
    /// # Errors
    /// Returns [`FsError::InvalidInput`] when `path` is not absolute or contains
    /// `.`, `..`, or a NUL byte.
    pub fn parse(path: &str) -> FsResult<Self> {
        if !path.starts_with('/') {
            return Err(FsError::InvalidInput);
        }

        let mut parts = Vec::new();
        for part in path.split('/') {
            if part.is_empty() {
                continue;
            }
            if part == "." || part == ".." || part.contains('\0') {
                return Err(FsError::InvalidInput);
            }
            parts.push(part.to_owned());
        }

        Ok(Self { parts })
    }

    /// Directory names from the root, excluding the empty segments of `/`.
    #[must_use]
    pub fn parts(&self) -> &[String] {
        &self.parts
    }

    /// Splits the path into the parent directories and the final name.
    ///
    /// # Errors
    /// Returns [`FsError::InvalidInput`] when the path is the root.
    pub fn parent_and_name(&self) -> FsResult<(&[String], &str)> {
        let Some((name, parent)) = self.parts.split_last() else {
            return Err(FsError::InvalidInput);
        };
        Ok((parent, name.as_str()))
    }
}
