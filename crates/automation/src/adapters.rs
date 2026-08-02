use std::{
    fs::{File, OpenOptions},
    path::Path,
};

use async_trait::async_trait;

use crate::{EngineError, OwnerLockPort};

#[derive(Clone, Debug)]
pub struct FileOwnerLock {
    file_name: String,
}

impl Default for FileOwnerLock {
    fn default() -> Self {
        Self {
            file_name: "automation-engine.lock".to_string(),
        }
    }
}

impl FileOwnerLock {
    pub fn new(file_name: impl Into<String>) -> Self {
        Self {
            file_name: file_name.into(),
        }
    }
}

#[async_trait]
impl OwnerLockPort for FileOwnerLock {
    type Lease = File;

    async fn try_acquire(&self, data_dir_key: &str) -> Result<Option<Self::Lease>, EngineError> {
        let path = Path::new(data_dir_key).join(&self.file_name);
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| EngineError::OwnerLock(error.to_string()))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(error)) => {
                Err(EngineError::OwnerLock(error.to_string()))
            }
        }
    }
}
