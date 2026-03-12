use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Permission policy for tool operations.
///
/// This is the minimal subset required by the restored ExecutorConfig /
/// ExecutorProfile separation. More complete model-selector metadata can be
/// restored later without changing this public shape.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
pub enum PermissionPolicy {
    #[default]
    Auto,
    Supervised,
    Plan,
}
