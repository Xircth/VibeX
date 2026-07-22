use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use browser_cef::{command_channel, command_channel_with_waker};
use browser_runtime::{BrowserEngine, BrowserEngineCommand, BrowserTabId};

#[test]
fn engine_handle_moves_runtime_commands_to_the_cef_ui_thread() {
    let (engine, commands) = command_channel(8);
    let command = BrowserEngineCommand::Reload {
        tab_id: BrowserTabId::from("tab-1"),
    };

    engine
        .dispatch(command.clone())
        .expect("CEF queue should accept command");

    assert_eq!(commands.try_recv(), Ok(command));
}

#[test]
fn accepted_commands_wake_the_cef_message_pump() {
    let wake_count = Arc::new(AtomicUsize::new(0));
    let observed = wake_count.clone();
    let (engine, _commands) = command_channel_with_waker(
        8,
        Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        }),
    );

    engine
        .dispatch(BrowserEngineCommand::Reload {
            tab_id: BrowserTabId::from("tab-1"),
        })
        .expect("CEF queue should accept command");

    assert_eq!(wake_count.load(Ordering::SeqCst), 1);
}
