//! Local Marketplace v1: static signed index + publisher TOFU.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::PluginError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceListing {
    pub publisher: String,
    pub plugin_id: String,
    pub version: String,
    pub summary: String,
    pub package_digest: String,
    pub archive: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceIndex {
    pub listings: Vec<MarketplaceListing>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherTofu {
    pub publishers: BTreeMap<String, String>,
}

pub fn load_index(path: &Path) -> Result<MarketplaceIndex, PluginError> {
    if !path.is_file() {
        return Ok(MarketplaceIndex::default());
    }
    serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|error| PluginError::io("read marketplace index", error))?,
    )
    .map_err(|error| PluginError::invalid_manifest(error.to_string()))
}

pub fn load_tofu(path: &Path) -> Result<PublisherTofu, PluginError> {
    if !path.is_file() {
        return Ok(PublisherTofu::default());
    }
    serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| PluginError::io("read publisher tofu", error))?,
    )
    .map_err(|error| PluginError::invalid_manifest(error.to_string()))
}

pub fn save_tofu(path: &Path, tofu: &PublisherTofu) -> Result<(), PluginError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| PluginError::io("create tofu dir", error))?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(tofu)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?,
    )
    .map_err(|error| PluginError::io("write publisher tofu", error))
}

pub fn remember_publisher(
    tofu: &mut PublisherTofu,
    publisher: &str,
    public_key: &str,
) -> Result<(), PluginError> {
    if let Some(known) = tofu.publishers.get(publisher) {
        if known != public_key {
            return Err(PluginError::invalid_manifest(format!(
                "publisher `{publisher}` does not match the remembered key"
            )));
        }
        return Ok(());
    }
    tofu.publishers
        .insert(publisher.to_owned(), public_key.to_owned());
    Ok(())
}

pub fn archive_digest(path: &Path) -> Result<String, PluginError> {
    let bytes =
        fs::read(path).map_err(|error| PluginError::io("read marketplace archive", error))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub fn default_index_path(data_root: &Path) -> PathBuf {
    data_root.join("plugins/index/official.v1.json")
}

pub fn default_tofu_path(data_root: &Path) -> PathBuf {
    data_root.join("plugins/publishers.json")
}
