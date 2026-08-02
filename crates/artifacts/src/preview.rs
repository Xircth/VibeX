use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use tool_runtime::ToolInstallationLock;

use crate::{ArtifactRecord, ArtifactServiceError, PreviewLease};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactProviderDescriptor {
    pub id: String,
    pub supported_media_types: Vec<String>,
    pub max_concurrent_previews: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactProviderProbe {
    pub ready: bool,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreviewReapReason {
    Expired,
    Crashed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReapedPreviewLease {
    pub lease_id: uuid::Uuid,
    pub artifact_id: uuid::Uuid,
    pub reason: PreviewReapReason,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderReapReport {
    pub processes_reaped: usize,
    pub leases: Vec<ReapedPreviewLease>,
}

#[derive(Clone, Debug)]
pub struct ProviderPreviewRequest {
    pub artifact: ArtifactRecord,
    pub tool: ToolInstallationLock,
}

#[async_trait]
pub trait ArtifactToolProvider: Send + Sync {
    fn descriptor(&self) -> ArtifactProviderDescriptor;

    async fn probe(
        &self,
        tool: &ToolInstallationLock,
    ) -> Result<ArtifactProviderProbe, ArtifactServiceError>;

    async fn open_preview(
        &self,
        request: ProviderPreviewRequest,
    ) -> Result<PreviewLease, ArtifactServiceError>;

    async fn close_preview(&self, lease_id: uuid::Uuid) -> Result<(), ArtifactServiceError>;

    async fn reap_idle(&self) -> Result<ProviderReapReport, ArtifactServiceError> {
        Ok(ProviderReapReport::default())
    }
}

#[derive(Clone, Default)]
pub struct PreviewProviderRegistry {
    providers: Arc<BTreeMap<String, Arc<dyn ArtifactToolProvider>>>,
}

impl PreviewProviderRegistry {
    pub fn from_providers<const N: usize>(
        providers: [Arc<dyn ArtifactToolProvider>; N],
    ) -> Result<Self, ArtifactServiceError> {
        let mut by_id = BTreeMap::new();
        for provider in providers {
            let descriptor = provider.descriptor();
            if descriptor.id.trim().is_empty()
                || descriptor.supported_media_types.is_empty()
                || descriptor.max_concurrent_previews == 0
            {
                return Err(ArtifactServiceError::Preview(
                    "provider descriptor is incomplete".into(),
                ));
            }
            let id = descriptor.id;
            if by_id.insert(id.clone(), provider).is_some() {
                return Err(ArtifactServiceError::DuplicateProvider(id));
            }
        }
        Ok(Self {
            providers: Arc::new(by_id),
        })
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<dyn ArtifactToolProvider>> {
        self.providers.get(id).cloned()
    }

    pub(crate) fn providers(&self) -> impl Iterator<Item = Arc<dyn ArtifactToolProvider>> + '_ {
        self.providers.values().cloned()
    }
}
