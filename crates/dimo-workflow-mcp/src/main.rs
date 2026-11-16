//! Host-family Workflow MCP server. Multiplexes stdio JSON-RPC over the bundled
//! Node workflow controller while natively serving the Dual-Primitive
//! `workflow_graph_patch` tool (`session` fresh context vs `bot` persistent
//! `memberId` context, `bounded_loop` with exhaustive `max_iterations` validation,
//! `wait_for_event`, `group_stage`, `user_gate`, `outbox_action`, and 5 presets).

mod graph_patch;
mod json;
mod presets;
#[cfg(test)]
mod tests;

use std::{
    collections::HashSet,
    env, fs,
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use graph_patch::{
    WORKFLOW_GRAPH_PATCH_TOOL_NAME, execute_workflow_graph_patch, workflow_graph_patch_tool_schema,
};
use json::Json;

const BUNDLED_SCRIPT: &[u8] =
    include_bytes!("../../../packages/dimo-workflow-mcp/dist/mcp/workflow-control.mjs");
const MODERN_MCP_PROTOCOL: &str = "2026-07-28";
const MCP_PROTOCOL_VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
const MCP_SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";

pub enum InboundRoute {
    HandledLocally(Option<String>),
    ForwardToChild { track_tools_list_id: Option<String> },
}

pub fn route_inbound_line(line: &str, cwd_override: Option<&Path>) -> InboundRoute {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return InboundRoute::ForwardToChild {
            track_tools_list_id: None,
        };
    }
    let Ok(msg) = Json::parse(trimmed) else {
        return InboundRoute::ForwardToChild {
            track_tools_list_id: None,
        };
    };
    let Some(method) = msg.get("method").and_then(Json::as_str) else {
        return InboundRoute::ForwardToChild {
            track_tools_list_id: None,
        };
    };
    match method {
        "tools/list" => {
            let id_key = msg.get("id").map(Json::to_compact_string);
            InboundRoute::ForwardToChild {
                track_tools_list_id: id_key,
            }
        }
        "tools/call" => {
            let params = msg.get("params");
            let tool_name = params
                .and_then(|p| p.get("name"))
                .and_then(Json::as_str)
                .unwrap_or("");
            if tool_name != WORKFLOW_GRAPH_PATCH_TOOL_NAME {
                return InboundRoute::ForwardToChild {
                    track_tools_list_id: None,
                };
            }
            let Some(id) = msg.get("id").cloned() else {
                return InboundRoute::HandledLocally(None);
            };
            let empty_args = Json::obj([]);
            let arguments = params
                .and_then(|p| p.get("arguments"))
                .unwrap_or(&empty_args);
            let outcome = execute_workflow_graph_patch(arguments, cwd_override);
            let is_error = outcome
                .get("isError")
                .and_then(Json::as_bool)
                .unwrap_or(false);
            let mut result = Json::obj([
                (
                    "content",
                    Json::arr([Json::obj([
                        ("type", Json::str("text")),
                        ("text", Json::str(outcome.to_pretty_string())),
                    ])]),
                ),
                ("structuredContent", outcome),
                ("isError", Json::Bool(is_error)),
            ]);
            if is_modern_protocol(params) {
                result.set("resultType", Json::str("complete"));
                result.set(
                    "_meta",
                    Json::obj([(
                        MCP_SERVER_INFO_META,
                        Json::obj([
                            ("name", Json::str("dimo-workflow-mcp")),
                            ("version", Json::str(env!("CARGO_PKG_VERSION"))),
                        ]),
                    )]),
                );
            }
            let envelope = Json::obj([
                ("jsonrpc", Json::str("2.0")),
                ("id", id),
                ("result", result),
            ]);
            InboundRoute::HandledLocally(Some(envelope.to_compact_string()))
        }
        _ => InboundRoute::ForwardToChild {
            track_tools_list_id: None,
        },
    }
}

pub fn augment_tools_list_response(line: &str, pending_ids: &mut HashSet<String>) -> String {
    if pending_ids.is_empty() {
        return line.to_string();
    }
    let Ok(mut msg) = Json::parse(line.trim()) else {
        return line.to_string();
    };
    let Some(id_key) = msg.get("id").map(Json::to_compact_string) else {
        return line.to_string();
    };
    if !pending_ids.remove(&id_key) {
        return line.to_string();
    }
    if let Some(tools) = msg
        .get_mut("result")
        .and_then(|r| r.get_mut("tools"))
        .and_then(Json::as_arr_mut)
    {
        let already_present = tools
            .iter()
            .any(|t| t.get("name").and_then(Json::as_str) == Some(WORKFLOW_GRAPH_PATCH_TOOL_NAME));
        if !already_present {
            tools.push(workflow_graph_patch_tool_schema());
        }
        return msg.to_compact_string();
    }
    line.to_string()
}

fn is_modern_protocol(params: Option<&Json>) -> bool {
    let Some(p) = params else {
        return false;
    };
    let direct = p.get(MCP_PROTOCOL_VERSION_META).and_then(Json::as_str);
    let nested = p
        .get("_meta")
        .and_then(|m| m.get(MCP_PROTOCOL_VERSION_META))
        .and_then(Json::as_str);
    direct.or(nested) == Some(MODERN_MCP_PROTOCOL)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("dimo-workflow-mcp: {error}");
        std::process::exit(2);
    }
}

fn run() -> io::Result<()> {
    let script = materialize_script()?;
    let node = resolve_node().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Node.js is required to run dimo-workflow-mcp",
        )
    })?;
    let mut child = Command::new(node)
        .arg(&script)
        .args(env::args().skip(1))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("failed to open child stdin"))?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("failed to open child stdout"))?;

    let stdout_lock: Arc<Mutex<io::Stdout>> = Arc::new(Mutex::new(io::stdout()));
    let pending_tools_list: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let reader_stdout = stdout_lock.clone();
    let reader_pending = pending_tools_list.clone();
    let stdout_pump = thread::spawn(move || {
        let reader = BufReader::new(child_stdout);
        for line_res in reader.lines() {
            let Ok(line) = line_res else {
                break;
            };
            let output_line = {
                let mut guard = reader_pending.lock().unwrap_or_else(|e| e.into_inner());
                augment_tools_list_response(&line, &mut guard)
            };
            let mut out = reader_stdout.lock().unwrap_or_else(|e| e.into_inner());
            let _ = writeln!(out, "{output_line}");
            let _ = out.flush();
        }
    });

    let stdin_reader = BufReader::new(io::stdin());
    for line_res in stdin_reader.lines() {
        let Ok(line) = line_res else {
            break;
        };
        match route_inbound_line(&line, None) {
            InboundRoute::HandledLocally(Some(response)) => {
                let mut out = stdout_lock.lock().unwrap_or_else(|e| e.into_inner());
                let _ = writeln!(out, "{response}");
                let _ = out.flush();
            }
            InboundRoute::HandledLocally(None) => {}
            InboundRoute::ForwardToChild {
                track_tools_list_id,
            } => {
                if let Some(id_key) = track_tools_list_id {
                    pending_tools_list
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(id_key);
                }
                if writeln!(child_stdin, "{line}").is_err() || child_stdin.flush().is_err() {
                    break;
                }
            }
        }
    }

    drop(child_stdin);
    let _ = stdout_pump.join();
    let status = child.wait()?;
    std::process::exit(status.code().unwrap_or(1));
}

fn materialize_script() -> io::Result<PathBuf> {
    if let Some(explicit) = env::var_os("DIMO_WORKFLOW_MCP_SCRIPT") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("workflow-control.mjs");
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    let dest = utils::path::get_dimo_temp_dir().join("dimo-workflow-mcp.mjs");
    if dest.is_file() && fs::read(&dest)? == BUNDLED_SCRIPT {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&dest, BUNDLED_SCRIPT)?;
    Ok(dest)
}

fn resolve_node() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("DIMO_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    utils::shell::resolve_executable_path_blocking("node")
}
