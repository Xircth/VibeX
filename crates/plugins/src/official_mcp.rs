use std::sync::atomic::{AtomicBool, Ordering};

use crate::PluginActivation;

/// Builtin product id that gates injection of `vibex-mcp`.
pub const COLLABORATION_PLUGIN_ID: &str = "vibex.collaboration";

/// Builtin product id that gates injection of `vibex-workflow-mcp`.
pub const WORKFLOW_CREATOR_PLUGIN_ID: &str = "vibex.workflow-creator";

/// Process-local switch read by the synchronous companion injector.
#[derive(Debug, Default)]
pub struct OfficialProductMcpGate {
    collaboration: AtomicBool,
    workflow: AtomicBool,
}

impl OfficialProductMcpGate {
    pub fn allow_vibex_mcp(&self) -> bool {
        self.collaboration.load(Ordering::SeqCst)
    }

    pub fn allow_workflow_mcp(&self) -> bool {
        self.workflow.load(Ordering::SeqCst)
    }

    pub fn observe(&self, plugin_id: &str, activation: PluginActivation) {
        let enabled = activation == PluginActivation::Enabled;
        match plugin_id {
            COLLABORATION_PLUGIN_ID => self.collaboration.store(enabled, Ordering::SeqCst),
            WORKFLOW_CREATOR_PLUGIN_ID => self.workflow.store(enabled, Ordering::SeqCst),
            _ => {}
        }
    }

    pub fn reset(&self) {
        self.collaboration.store(false, Ordering::SeqCst);
        self.workflow.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_mcp_stays_off_until_the_matching_plugin_is_enabled() {
        let gate = OfficialProductMcpGate::default();
        assert!(!gate.allow_vibex_mcp());
        assert!(!gate.allow_workflow_mcp());

        gate.observe(COLLABORATION_PLUGIN_ID, PluginActivation::Enabled);
        assert!(gate.allow_vibex_mcp());
        assert!(!gate.allow_workflow_mcp());

        gate.observe(COLLABORATION_PLUGIN_ID, PluginActivation::Disabled);
        gate.observe(WORKFLOW_CREATOR_PLUGIN_ID, PluginActivation::Enabled);
        assert!(!gate.allow_vibex_mcp());
        assert!(gate.allow_workflow_mcp());
    }
}
