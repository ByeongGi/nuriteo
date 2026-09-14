use super::error::{FsError, FsResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AbsolutePath {
    parts: Vec<String>,
}

impl AbsolutePath {
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

    pub fn parts(&self) -> &[String] {
        &self.parts
    }

    pub fn parent_and_name(&self) -> FsResult<(&[String], &str)> {
        let Some((name, parent)) = self.parts.split_last() else {
            return Err(FsError::InvalidInput);
        };
        Ok((parent, name.as_str()))
    }
}
