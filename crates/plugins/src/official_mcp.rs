use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use crate::PluginActivation;

/// Predecessor id. Still observed so an older install that enabled this
/// plugin continues to open the multi-agent gate.
pub const COLLABORATION_PLUGIN_ID: &str = "vibex.collaboration";

/// Builtin product that owns `vibex-delegation-mcp`.
pub const MULTI_AGENT_PLUGIN_ID: &str = "vibex.multi-agent";

/// Builtin product that owns `vibex-session-mcp`.
pub const SESSION_ENHANCE_PLUGIN_ID: &str = "vibex.session-enhance";

/// Builtin product id that gates injection of `vibex-workflow-mcp`.
pub const WORKFLOW_CREATOR_PLUGIN_ID: &str = "vibex.workflow-creator";

pub const SESSION_FEAT_FEEDBACK: u8 = 1;
pub const SESSION_FEAT_ASK: u8 = 1 << 1;
pub const SESSION_FEAT_SESSIONS: u8 = 1 << 2;
pub const SESSION_FEAT_SESSION_CONTROL: u8 = 1 << 3;
pub const SESSION_FEAT_ALL: u8 =
    SESSION_FEAT_FEEDBACK | SESSION_FEAT_ASK | SESSION_FEAT_SESSIONS | SESSION_FEAT_SESSION_CONTROL;

/// Process-local switch read by the synchronous companion injector.
#[derive(Debug, Default)]
pub struct OfficialProductMcpGate {
    multi_agent: AtomicBool,
    session_enhance: AtomicBool,
    workflow: AtomicBool,
    session_features: AtomicU8,
    delegation_token: Mutex<Option<String>>,
    session_token: Mutex<Option<String>>,
    http_base: Mutex<Option<String>>,
}

impl OfficialProductMcpGate {
    pub fn allow_delegation_mcp(&self) -> bool {
        self.multi_agent.load(Ordering::SeqCst)
    }

    /// Backward-compatible name used by ADR-0055 tests and older callers.
    pub fn allow_vibex_mcp(&self) -> bool {
        self.allow_delegation_mcp()
    }

    pub fn allow_session_mcp(&self) -> bool {
        self.session_enhance.load(Ordering::SeqCst)
    }

    pub fn allow_workflow_mcp(&self) -> bool {
        self.workflow.load(Ordering::SeqCst)
    }

    pub fn session_features(&self) -> u8 {
        if !self.allow_session_mcp() {
            return 0;
        }
        let bits = self.session_features.load(Ordering::SeqCst);
        if bits == 0 { SESSION_FEAT_ALL } else { bits }
    }

    pub fn set_session_features(&self, bits: u8) {
        self.session_features.store(bits, Ordering::SeqCst);
    }

    pub fn delegation_token(&self) -> Option<String> {
        self.delegation_token.lock().unwrap().clone()
    }

    pub fn session_token(&self) -> Option<String> {
        self.session_token.lock().unwrap().clone()
    }

    pub fn ensure_delegation_token(&self) -> String {
        ensure_token(&self.delegation_token)
    }

    pub fn ensure_session_token(&self) -> String {
        ensure_token(&self.session_token)
    }

    pub fn set_http_base(&self, base: Option<String>) {
        *self.http_base.lock().unwrap() = base;
    }

    pub fn http_base(&self) -> Option<String> {
        self.http_base.lock().unwrap().clone()
    }

    pub fn observe(&self, plugin_id: &str, activation: PluginActivation) {
        let enabled = activation == PluginActivation::Enabled;
        match plugin_id {
            MULTI_AGENT_PLUGIN_ID | COLLABORATION_PLUGIN_ID => {
                self.multi_agent.store(enabled, Ordering::SeqCst);
                if enabled {
                    let _ = self.ensure_delegation_token();
                } else {
                    *self.delegation_token.lock().unwrap() = None;
                }
            }
            SESSION_ENHANCE_PLUGIN_ID => {
                self.session_enhance.store(enabled, Ordering::SeqCst);
                if enabled {
                    let _ = self.ensure_session_token();
                } else {
                    *self.session_token.lock().unwrap() = None;
                }
            }
            WORKFLOW_CREATOR_PLUGIN_ID => self.workflow.store(enabled, Ordering::SeqCst),
            _ => {}
        }
    }

    pub fn reset(&self) {
        self.multi_agent.store(false, Ordering::SeqCst);
        self.session_enhance.store(false, Ordering::SeqCst);
        self.workflow.store(false, Ordering::SeqCst);
        self.session_features.store(0, Ordering::SeqCst);
        *self.delegation_token.lock().unwrap() = None;
        *self.session_token.lock().unwrap() = None;
        *self.http_base.lock().unwrap() = None;
    }
}

fn ensure_token(slot: &Mutex<Option<String>>) -> String {
    let mut guard = slot.lock().unwrap();
    if guard.is_none() {
        *guard = Some(uuid::Uuid::new_v4().to_string());
    }
    guard.clone().expect("token just inserted")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_mcp_stays_off_until_the_matching_plugin_is_enabled() {
        let gate = OfficialProductMcpGate::default();
        assert!(!gate.allow_delegation_mcp());
        assert!(!gate.allow_session_mcp());
        assert!(!gate.allow_workflow_mcp());

        gate.observe(MULTI_AGENT_PLUGIN_ID, PluginActivation::Enabled);
        assert!(gate.allow_delegation_mcp());
        assert!(!gate.allow_session_mcp());

        gate.observe(COLLABORATION_PLUGIN_ID, PluginActivation::Enabled);
        assert!(gate.allow_delegation_mcp());

        gate.observe(MULTI_AGENT_PLUGIN_ID, PluginActivation::Disabled);
        gate.observe(COLLABORATION_PLUGIN_ID, PluginActivation::Disabled);
        gate.observe(SESSION_ENHANCE_PLUGIN_ID, PluginActivation::Enabled);
        gate.observe(WORKFLOW_CREATOR_PLUGIN_ID, PluginActivation::Enabled);
        assert!(!gate.allow_delegation_mcp());
        assert!(gate.allow_session_mcp());
        assert!(gate.allow_workflow_mcp());
        assert_eq!(gate.session_features(), SESSION_FEAT_ALL);
    }

    #[test]
    fn session_feature_bits_are_ignored_while_the_plugin_is_off() {
        let gate = OfficialProductMcpGate::default();
        gate.set_session_features(SESSION_FEAT_ASK);
        assert_eq!(gate.session_features(), 0);
        gate.observe(SESSION_ENHANCE_PLUGIN_ID, PluginActivation::Enabled);
        assert_eq!(gate.session_features(), SESSION_FEAT_ASK);
    }
}
