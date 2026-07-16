//! Temporary repro: does fast typing right after PTY creation lose input?
//! Run with: cargo test -p local-deployment --test pty_typeahead_repro -- --nocapture --ignored

use std::time::Duration;

use local_deployment::pty::PtyService;

async fn run_case(delay_before_typing_ms: u64) -> String {
    let service = PtyService::new();
    let cwd = std::env::temp_dir();
    let (session_id, mut rx) = service
        .create_session(cwd, 100, 30, None, None)
        .await
        .expect("create session");

    tokio::time::sleep(Duration::from_millis(delay_before_typing_ms)).await;

    // Simulate fast typing: 'c' first, then the rest as a second chunk,
    // mirroring the frontend's microtask-coalesced writes.
    service.write(session_id, b"c").await.expect("write c");
    tokio::time::sleep(Duration::from_millis(30)).await;
    service
        .write(session_id, b"d ..\r")
        .await
        .expect("write rest");

    // Collect output for a while.
    let mut collected: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(chunk)) => collected.extend_from_slice(&chunk),
            _ => break,
        }
    }

    let _ = service.close_session(session_id).await;
    String::from_utf8_lossy(&collected).to_string()
}

#[tokio::test]
#[ignore]
async fn typeahead_immediately_after_create() {
    let output = run_case(0).await;
    println!("=== immediate typing output ===\n{output}\n===");
    println!("contains 'cd ..': {}", output.contains("cd .."));
}

#[tokio::test]
#[ignore]
async fn typeahead_after_shell_ready() {
    let output = run_case(1500).await;
    println!("=== delayed typing output ===\n{output}\n===");
    println!("contains 'cd ..': {}", output.contains("cd .."));
}
