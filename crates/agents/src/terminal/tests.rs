use std::{path::Path, time::Duration};

use super::{
    AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalRegistry,
    DEFAULT_OUTPUT_BYTE_LIMIT, HARD_OUTPUT_BYTE_LIMIT, OutputTap, TERMINAL_OUTPUT_BUFFER,
    TerminalOutputChunk, can_retry_command_through_shell, default_platform_shell,
    effective_output_byte_limit, is_utf8_boundary_byte, resolve_fallback_shell,
    resolve_terminal_cwd, shell_wrapped_command, trim_output_history,
};
use crate::{
    ids::AgentSessionId,
    shell_flavor::{ShellFamily, classify_shell_family},
};

#[test]
fn agent_output_byte_limit_is_hard_capped() {
    assert_eq!(effective_output_byte_limit(None), DEFAULT_OUTPUT_BYTE_LIMIT);
    assert_eq!(
        effective_output_byte_limit(Some(0)),
        DEFAULT_OUTPUT_BYTE_LIMIT
    );
    assert_eq!(
        effective_output_byte_limit(Some(u64::MAX)),
        HARD_OUTPUT_BYTE_LIMIT
    );
    assert_eq!(effective_output_byte_limit(Some(4096)), 4096);
}

fn request(command: &str) -> AgentTerminalCreateRequest {
    AgentTerminalCreateRequest {
        session_id: AgentSessionId::new(),
        command: command.to_string(),
        args: Vec::new(),
        cwd: None,
        env: Vec::new(),
        output_byte_limit: Some(4096),
    }
}

async fn run_and_capture(command: &str) -> String {
    run_request(request(command)).await
}

async fn run_request(request: AgentTerminalCreateRequest) -> String {
    let registry = AgentTerminalRegistry::new();
    let terminal_id = registry
        .create_terminal(&request)
        .await
        .expect("create terminal");
    let _ = registry.wait_for_exit(terminal_id).await;
    let snapshot = registry
        .snapshot_output(terminal_id)
        .await
        .expect("terminal snapshot");
    registry.release_terminal(terminal_id).await;
    snapshot.output
}

fn wrapped_argv(shell: &str, line: &str) -> (String, Vec<String>) {
    let command = shell_wrapped_command(shell, line);
    let std_command = command.as_std();
    (
        std_command.get_program().to_string_lossy().to_string(),
        std_command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect(),
    )
}

#[test]
fn posix_wrap_passes_the_line_as_one_argument() {
    let (program, args) = wrapped_argv("/bin/sh", "echo hello world");
    assert_eq!(program, "/bin/sh");
    assert_eq!(args, vec!["-c".to_string(), "echo hello world".to_string()]);
}

#[test]
fn powershell_wrap_uses_command_flag() {
    let (program, args) = wrapped_argv("pwsh.exe", "Get-ChildItem");
    assert_eq!(program, "pwsh.exe");
    assert_eq!(
        args,
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            "Get-ChildItem".to_string(),
        ]
    );
}

#[test]
fn cmd_wrap_uses_slash_c() {
    let (program, args) = wrapped_argv("cmd.exe", "echo hello");
    assert_eq!(program, "cmd.exe");
    assert_eq!(
        args,
        vec![
            "/D".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            "echo hello".to_string(),
        ]
    );
}

#[test]
fn whitespace_command_without_args_retries_through_posix_shell() {
    assert!(can_retry_command_through_shell(
        "echo hello world",
        &[],
        "/bin/sh"
    ));
    assert!(!can_retry_command_through_shell("pwd", &[], "/bin/sh"));
    assert!(!can_retry_command_through_shell(
        "git",
        &["status".to_string()],
        "/bin/sh"
    ));
    assert!(can_retry_command_through_shell("dir", &[], "cmd.exe"));
}

#[test]
fn unknown_unix_shells_are_posix() {
    assert_eq!(classify_shell_family("/bin/sh"), ShellFamily::Posix);
    assert!(!ShellFamily::Posix.resolves_bare_builtins());
    assert!(ShellFamily::Cmd.resolves_bare_builtins());
    assert!(ShellFamily::PowerShell.resolves_bare_builtins());
}

fn touch(path: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, []).expect("touch");
}

#[test]
fn unset_windows_shell_prefers_powershell_then_cmd_never_git_bash() {
    let dir = tempfile::tempdir().expect("temp dir");
    let cmd = dir.path().join("System32").join("cmd.exe");
    let powershell = dir.path().join("WindowsPowerShell").join("powershell.exe");
    touch(&cmd);
    touch(&powershell);

    assert_eq!(
        super::default_windows_platform_shell(
            [powershell.clone()],
            [cmd.clone()],
            Some(r"C:\Windows\System32\cmd.exe".to_string()),
        ),
        powershell.to_string_lossy()
    );
    assert_eq!(
        super::default_windows_platform_shell(
            [],
            [cmd.clone()],
            Some(r"C:\Windows\System32\cmd.exe".to_string()),
        ),
        cmd.to_string_lossy()
    );
    assert_eq!(
        super::default_windows_platform_shell(
            [],
            [],
            Some("  C:\\Windows\\System32\\cmd.exe  ".to_string()),
        ),
        r"C:\Windows\System32\cmd.exe"
    );
    assert_eq!(
        super::default_windows_platform_shell([], [], None),
        "cmd.exe"
    );
}

#[test]
fn configured_shell_is_used_as_agent_fallback() {
    assert_eq!(resolve_fallback_shell(Some("pwsh.exe")), "pwsh.exe");
    assert_eq!(resolve_fallback_shell(Some("cmd.exe")), "cmd.exe");
    assert_eq!(
        resolve_fallback_shell(Some("warp")),
        default_platform_shell()
    );
    assert_eq!(
        resolve_fallback_shell(Some("   ")),
        default_platform_shell()
    );
    assert_eq!(resolve_fallback_shell(None), default_platform_shell());
}

#[test]
fn configured_bash_uses_git_bash_when_present() {
    let dir = tempfile::tempdir().expect("temp dir");
    let bash = dir.path().join("Git").join("bin").join("bash.exe");
    touch(&bash);
    assert_eq!(
        super::prefer_git_bash([bash.clone()], "bash.exe"),
        bash.to_string_lossy()
    );
    assert_eq!(super::prefer_git_bash([], "bash.exe"), "bash.exe");
}

#[tokio::test]
async fn default_shell_config_hot_swaps_on_the_next_create() {
    let registry = AgentTerminalRegistry::new();
    assert_eq!(registry.default_shell().await, None);
    registry
        .set_default_shell(Some("  pwsh.exe  ".to_string()))
        .await;
    assert_eq!(registry.default_shell().await.as_deref(), Some("pwsh.exe"));
    registry.set_default_shell(None).await;
    assert_eq!(registry.default_shell().await, None);
}

#[test]
fn wsl_stub_bash_is_not_treated_as_git_bash() {
    assert!(super::is_wsl_bash(Path::new(
        r"C:\Windows\System32\bash.exe"
    )));
    assert!(super::is_wsl_bash(Path::new("/Windows/System32/bash.exe")));
    assert!(!super::is_wsl_bash(Path::new(
        r"C:\Program Files\Git\bin\bash.exe"
    )));
}

#[test]
fn omitted_cwd_falls_back_to_a_real_session_directory() {
    let dir = tempfile::tempdir().expect("temp dir");
    let resolved = resolve_terminal_cwd(None, dir.path()).expect("resolve omitted cwd");
    assert_eq!(resolved.as_deref(), Some(dir.path()));
}

#[test]
fn explicit_cwd_is_kept_even_when_missing() {
    let dir = tempfile::tempdir().expect("temp dir");
    let missing = dir
        .path()
        .join("dimo-nonexistent-cwd")
        .join("does")
        .join("not")
        .join("exist");
    let resolved = resolve_terminal_cwd(Some(&missing), dir.path()).expect("keep explicit cwd");
    assert_eq!(resolved.as_deref(), Some(missing.as_path()));
}

#[test]
fn relative_cwd_is_rejected() {
    let dir = tempfile::tempdir().expect("temp dir");
    let error = resolve_terminal_cwd(Some(Path::new("relative/path")), dir.path())
        .expect_err("relative cwd");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[tokio::test]
async fn whitespace_command_runs_through_shell() {
    let output = run_and_capture("echo \"hello world\"").await;
    assert!(
        output.contains("hello world"),
        "shell did not run the whitespace command; got:\n{output}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shell_operators_evaluate() {
    let output = run_and_capture("true && echo OK").await;
    assert!(
        output.contains("OK"),
        "shell operators did not evaluate; got:\n{output}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn grok_style_bash_lc_command_line_runs() {
    let output = run_and_capture("/bin/bash -lc pwd").await;
    assert!(
        output.contains('/'),
        "grok-style bash -lc line did not run; got:\n{output:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unset_default_runs_the_platform_shell_not_the_login_shell() {
    assert_eq!(default_platform_shell(), "/bin/sh");
    let output = run_and_capture("echo \"ran-under=$0\"").await;
    assert!(
        output.contains("ran-under=/bin/sh"),
        "unset default did not run through /bin/sh; got:\n{output}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn overlong_command_line_falls_back_to_shell() {
    let marker = "x".repeat(5000);
    let mut request = request(&format!("echo {marker}"));
    request.output_byte_limit = Some(64 * 1024);
    let output = run_request(request).await;
    assert!(
        output.contains(&marker),
        "overlong command line did not run via the shell fallback; got {} bytes",
        output.len()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_args_bypass_shell_wrap() {
    let mut request = request("/bin/echo");
    request.args = vec!["hello world".into()];
    let output = run_request(request).await;
    assert!(
        output.contains("hello world"),
        "direct exec did not pass the single arg through; got:\n{output}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shell_wrapped_command_respects_cwd() {
    let dir = tempfile::tempdir().expect("temp dir");
    let canonical = dir.path().canonicalize().expect("canonicalize");
    let mut request = request("pwd && echo done");
    request.cwd = Some(dir.path().display().to_string());
    let output = run_request(request).await;
    assert!(
        output.contains(canonical.to_string_lossy().as_ref()) && output.contains("done"),
        "shell-wrapped command ignored cwd; got:\n{output}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn space_containing_executable_is_direct_execd() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("temp dir");
    let binary = dir.path().join("my tool");
    std::fs::write(&binary, "#!/bin/sh\necho acp-space-ok\n").expect("write tool");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let output = run_and_capture(binary.to_str().expect("utf8 path")).await;
    assert!(
        output.contains("acp-space-ok"),
        "space-containing executable was not exec'd directly; got:\n{output}"
    );
}

#[tokio::test]
async fn empty_command_is_rejected() {
    let registry = AgentTerminalRegistry::new();
    let error = registry
        .create_terminal(&request("   "))
        .await
        .expect_err("empty command");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

fn hang_request() -> AgentTerminalCreateRequest {
    #[cfg(windows)]
    {
        AgentTerminalCreateRequest {
            session_id: AgentSessionId::new(),
            command: "ping".to_string(),
            args: vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()],
            cwd: None,
            env: Vec::new(),
            output_byte_limit: Some(4096),
        }
    }
    #[cfg(not(windows))]
    {
        AgentTerminalCreateRequest {
            session_id: AgentSessionId::new(),
            command: "sleep".to_string(),
            args: vec!["30".to_string()],
            cwd: None,
            env: Vec::new(),
            output_byte_limit: Some(4096),
        }
    }
}

/// Codeg parity: an outstanding `wait_for_exit` on a command that never
/// exits must not block `terminal/output` or `terminal/kill`. Those stay
/// on the ACP dispatch loop; wait_for_exit is answered off it.
#[tokio::test]
async fn output_and_kill_work_while_wait_for_exit_is_outstanding() {
    let registry = AgentTerminalRegistry::new();
    let terminal_id = registry
        .create_terminal(&hang_request())
        .await
        .expect("create hang terminal");

    let wait = registry.wait_for_exit(terminal_id);
    tokio::pin!(wait);
    tokio::select! {
        _ = &mut wait => panic!("wait_for_exit returned before the command was killed"),
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
    }

    tokio::time::timeout(
        Duration::from_secs(5),
        registry.snapshot_output(terminal_id),
    )
    .await
    .expect("terminal_output blocked behind an outstanding wait_for_exit")
    .expect("snapshot");

    tokio::time::timeout(Duration::from_secs(10), registry.kill_terminal(terminal_id))
        .await
        .expect("kill_terminal blocked behind an outstanding wait_for_exit");

    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("the outstanding wait never resolved after the kill")
        .expect("wait for exit");

    registry.release_terminal(terminal_id).await;
}

#[cfg(unix)]
#[tokio::test]
async fn has_running_for_session_is_true_only_while_the_child_is_alive() {
    let registry = AgentTerminalRegistry::new();
    let session_id = AgentSessionId::new();
    let other_session = AgentSessionId::new();
    let terminal_id = registry
        .create_terminal(&AgentTerminalCreateRequest {
            session_id,
            command: "sleep".to_string(),
            args: vec!["30".to_string()],
            cwd: None,
            env: Vec::new(),
            output_byte_limit: Some(4096),
        })
        .await
        .expect("create sleep terminal");

    assert!(registry.has_running_for_session(session_id).await);
    assert!(!registry.has_running_for_session(other_session).await);

    assert!(registry.kill_terminal(terminal_id).await);
    let _ = registry.wait_for_exit(terminal_id).await;
    assert!(!registry.has_running_for_session(session_id).await);

    registry.release_terminal(terminal_id).await;
}

#[test]
fn trim_output_history_prefers_line_boundary_after_overflow() {
    let mut history = std::collections::VecDeque::from(vec![b'a'; DEFAULT_OUTPUT_BYTE_LIMIT + 10]);
    history[12] = b'\n';

    assert!(trim_output_history(&mut history, DEFAULT_OUTPUT_BYTE_LIMIT));

    assert_eq!(history.len(), DEFAULT_OUTPUT_BYTE_LIMIT + 10 - 13);
    assert_eq!(history[0], b'a');
}

#[test]
fn trim_output_history_does_not_start_with_utf8_continuation_byte() {
    let mut history = std::collections::VecDeque::from(vec![b'a'; DEFAULT_OUTPUT_BYTE_LIMIT + 4]);
    let bytes = [0xe5, 0xa5, 0xbd];
    for (idx, byte) in bytes.iter().enumerate() {
        history[2 + idx] = *byte;
    }

    assert!(trim_output_history(&mut history, DEFAULT_OUTPUT_BYTE_LIMIT));

    assert!(
        history
            .front()
            .is_none_or(|byte| is_utf8_boundary_byte(*byte))
    );
}

#[test]
fn trim_output_history_preserves_recent_bytes_across_wrapped_ring_chunks() {
    let mut history = std::collections::VecDeque::new();
    history.extend(&vec![b'x'; 64]);
    history.drain(..48);
    history.extend(b"first-line\nsecond-line\nthird-line");

    assert!(trim_output_history(&mut history, 20));
    let contiguous = history.make_contiguous();
    assert!(std::str::from_utf8(contiguous).is_ok());
    assert!(contiguous.ends_with(b"third-line"));
}

#[tokio::test]
async fn output_tap_drops_the_oldest_chunk_when_full() {
    let tap = OutputTap::new();
    for index in 0..=TERMINAL_OUTPUT_BUFFER {
        tap.push(TerminalOutputChunk {
            seq: index as u64 + 1,
            data: vec![index as u8],
        });
    }
    assert_eq!(
        tap.recv().await,
        Some(TerminalOutputChunk {
            seq: 2,
            data: vec![1]
        })
    );
    for _ in 1..TERMINAL_OUTPUT_BUFFER - 1 {
        assert!(tap.recv().await.is_some());
    }
    assert_eq!(
        tap.recv().await,
        Some(TerminalOutputChunk {
            seq: TERMINAL_OUTPUT_BUFFER as u64 + 1,
            data: vec![TERMINAL_OUTPUT_BUFFER as u8]
        })
    );
    tap.close();
    assert_eq!(tap.recv().await, None);
}

#[tokio::test]
async fn release_all_for_session_terminates_running_process_and_unblocks_watchdog() {
    let registry = AgentTerminalRegistry::new();
    let session_id = AgentSessionId::new();
    let (command, args) = if cfg!(windows) {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 30".to_string(),
            ],
        )
    } else {
        ("sleep".to_string(), vec!["30".to_string()])
    };
    let terminal_id = registry
        .create_terminal(&AgentTerminalCreateRequest {
            session_id,
            command,
            args,
            cwd: None,
            env: Vec::new(),
            output_byte_limit: Some(4096),
        })
        .await
        .expect("create long-running terminal");

    assert!(registry.has_running_for_session(session_id).await);

    let released = registry.release_all_for_session(session_id).await;
    assert_eq!(released, vec![terminal_id]);
    assert!(
        !registry.has_running_for_session(session_id).await,
        "has_running_for_session must be false immediately after release_all_for_session"
    );
    assert!(!registry.exists(terminal_id).await);
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 probes process existence without delivering a signal.
        let exists = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !exists {
            return false;
        }
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            && let Some(rparen) = stat.rfind(')')
            && stat[rparen + 1..].trim_start().starts_with('Z')
        {
            return false;
        }
        true
    }
    #[cfg(windows)]
    {
        use workspace_utils::process::configure_std_command_no_window;

        let mut command = std::process::Command::new("tasklist.exe");
        configure_std_command_no_window(&mut command);
        let Ok(output) = command
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
        else {
            return false;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.contains(&format!("\"{pid}\""))
    }
}

async fn wait_for_pid_file(path: &Path) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(raw) = std::fs::read_to_string(path)
            && let Ok(pid) = raw.trim().parse::<u32>()
            && pid > 0
        {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for grandchild PID file at {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_process_exit(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while process_is_alive(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "grandchild process {pid} survived ProcessTreeJob termination"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn kill_and_release_reap_spawned_background_grandchild_via_process_tree_job() {
    let dir = tempfile::tempdir().expect("temp dir");
    let pid_file_kill = dir.path().join("kill_grandchild.pid");
    let registry = AgentTerminalRegistry::new();

    // 1. Live intermediate shell + background grandchild -> `kill_terminal` reaps both.
    let (kill_cmd, kill_args) = if cfg!(windows) {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1'; \
                 [System.IO.File]::WriteAllText($env:DIMO_TEST_PID_FILE, $p.Id.ToString()); \
                 Start-Sleep -Seconds 30"
                    .to_string(),
            ],
        )
    } else {
        (
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > \"$DIMO_TEST_PID_FILE\"; sleep 30"
                    .to_string(),
            ],
        )
    };
    let kill_tid = registry
        .create_terminal(&AgentTerminalCreateRequest {
            session_id: AgentSessionId::new(),
            command: kill_cmd,
            args: kill_args,
            cwd: None,
            env: vec![AgentTerminalEnvVar {
                name: "DIMO_TEST_PID_FILE".to_string(),
                value: pid_file_kill.to_string_lossy().into_owned(),
            }],
            output_byte_limit: Some(4096),
        })
        .await
        .expect("create terminal with live grandchild");

    let kill_grandchild_pid = wait_for_pid_file(&pid_file_kill).await;
    assert!(
        process_is_alive(kill_grandchild_pid),
        "expected grandchild {kill_grandchild_pid} to be running before kill_terminal"
    );

    assert!(registry.kill_terminal(kill_tid).await);
    let _ = registry.wait_for_exit(kill_tid).await;
    wait_for_process_exit(kill_grandchild_pid).await;
    registry.release_terminal(kill_tid).await;

    // 2. Intermediate shell exits immediately after spawning a detached background child ->
    // `release_terminal` still reaps the orphaned grandchild via `ProcessTreeJob`.
    let pid_file_release = dir.path().join("release_grandchild.pid");
    let (rel_cmd, rel_args) = if cfg!(windows) {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1'; \
                 [System.IO.File]::WriteAllText($env:DIMO_TEST_PID_FILE, $p.Id.ToString())"
                    .to_string(),
            ],
        )
    } else {
        (
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > \"$DIMO_TEST_PID_FILE\""
                    .to_string(),
            ],
        )
    };
    let rel_tid = registry
        .create_terminal(&AgentTerminalCreateRequest {
            session_id: AgentSessionId::new(),
            command: rel_cmd,
            args: rel_args,
            cwd: None,
            env: vec![AgentTerminalEnvVar {
                name: "DIMO_TEST_PID_FILE".to_string(),
                value: pid_file_release.to_string_lossy().into_owned(),
            }],
            output_byte_limit: Some(4096),
        })
        .await
        .expect("create terminal with detached grandchild");

    let _ = registry.wait_for_exit(rel_tid).await;
    let rel_grandchild_pid = wait_for_pid_file(&pid_file_release).await;
    assert!(
        process_is_alive(rel_grandchild_pid),
        "expected detached grandchild {rel_grandchild_pid} to survive intermediate shell exit before release_terminal"
    );

    assert!(registry.release_terminal(rel_tid).await);
    wait_for_process_exit(rel_grandchild_pid).await;
}
