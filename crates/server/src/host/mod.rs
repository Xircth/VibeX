pub mod account_flow;
pub mod catalog;
pub mod collaboration;
pub mod conversation;
pub mod conversation_handoff;
pub mod db_health;
pub mod events;
pub mod local_history;
pub mod management;
pub mod native;
pub mod native_commands;
pub mod plugin_conversation;
pub(crate) mod plugin_native;
pub(crate) mod plugin_projections;
pub(crate) mod plugin_updates;
pub mod product;
pub mod provider_bind;
pub mod provider_instances;
pub mod remote_profiles;
pub mod rewind_and_recovery;
pub mod row_ops;
pub mod side_chat;
pub mod streams;
pub mod surface;
pub mod workspace_files;
pub mod workspace_parity;

pub use events::{
    HostEvent, HostEventBus, patch_stream_channel, patch_stream_subscribe_command,
    patch_stream_task_key,
};
pub use row_ops::HostRowOpPublisher;
