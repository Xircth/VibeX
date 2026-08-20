//! Host-family Workflow MCP. Execs the bundled Node stdio server with the
//! same environment the plugin previously launched itself.

use std::{
    env, fs, io,
    path::PathBuf,
    process::{Command, Stdio},
};

const BUNDLED_SCRIPT: &[u8] =
    include_bytes!("../../../packages/vibex-workflow-mcp/dist/mcp/workflow-control.mjs");

fn main() {
    if let Err(error) = run() {
        eprintln!("vibex-workflow-mcp: {error}");
        std::process::exit(2);
    }
}

fn run() -> io::Result<()> {
    let script = materialize_script()?;
    let node = resolve_node().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Node.js is required to run vibex-workflow-mcp",
        )
    })?;
    let status = Command::new(node)
        .arg(&script)
        .args(env::args().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

fn materialize_script() -> io::Result<PathBuf> {
    if let Some(explicit) = env::var_os("VIBEX_WORKFLOW_MCP_SCRIPT") {
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
    let dest = utils::path::get_vibex_temp_dir().join("vibex-workflow-mcp.mjs");
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
    if let Some(explicit) = env::var_os("VIBEX_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    utils::shell::resolve_executable_path_blocking("node")
}
