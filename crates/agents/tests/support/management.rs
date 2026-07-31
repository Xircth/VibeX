#![allow(dead_code)]

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use agents::{
    BoundaryError, Clock, InstallInvocation, InstallOutput, InstallRunner, NativeFileMetadata,
    NativeFileSystem, RegistryFetchResponse, RegistryFetcher,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};

pub struct FakeRegistryFetcher {
    pub response: RegistryFetchResponse,
    pub requests: Mutex<Vec<(String, Option<String>)>>,
}

#[async_trait]
impl RegistryFetcher for FakeRegistryFetcher {
    async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<RegistryFetchResponse, BoundaryError> {
        self.requests
            .lock()
            .unwrap()
            .push((url.to_string(), etag.map(ToOwned::to_owned)));
        Ok(self.response.clone())
    }
}

pub struct FakeInstallRunner {
    pub output: InstallOutput,
    pub invocations: Mutex<Vec<InstallInvocation>>,
}

#[async_trait]
impl InstallRunner for FakeInstallRunner {
    async fn run(&self, invocation: InstallInvocation) -> Result<InstallOutput, BoundaryError> {
        self.invocations.lock().unwrap().push(invocation);
        Ok(self.output.clone())
    }
}

pub struct FixedClock(pub DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Default)]
pub struct MemoryNativeFileSystem {
    pub files: Mutex<HashMap<PathBuf, Vec<u8>>>,
}

#[async_trait]
impl NativeFileSystem for MemoryNativeFileSystem {
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>, BoundaryError> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }

    async fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), BoundaryError> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), bytes.to_vec());
        Ok(())
    }

    async fn remove_file(&self, path: &Path) -> Result<(), BoundaryError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn metadata(&self, path: &Path) -> Result<Option<NativeFileMetadata>, BoundaryError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|bytes| NativeFileMetadata {
                length: bytes.len() as u64,
            }))
    }
}
