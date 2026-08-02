use std::{env, process::ExitCode};

fn main() -> ExitCode {
    let Some(output) = env::args_os().nth(1) else {
        eprintln!("usage: export_remote_protocol <output-directory>");
        return ExitCode::FAILURE;
    };

    match remote_protocol::write_protocol_schema_artifacts(output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("failed to export remote protocol: {error}");
            ExitCode::FAILURE
        }
    }
}
