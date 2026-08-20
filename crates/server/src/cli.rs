use std::net::{IpAddr, SocketAddr};

use crate::ServerConfig;

const DEFAULT_PORT: u16 = 17891;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchCommand {
    Version,
    Help,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentsCommand {
    List { json: bool, refresh: bool },
    Install { agent_id: String, yes: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerLaunch {
    pub allow_lan: bool,
    pub port: u16,
    pub rotate_token: bool,
    pub reveal_console: bool,
}

impl ServerLaunch {
    pub fn listen_addr(&self) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(ServerConfig::bind_ip(self.allow_lan)), self.port)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParsedArgs {
    Command(LaunchCommand),
    Agents(AgentsCommand),
    Start(ServerLaunch),
}

#[derive(Debug, Eq, PartialEq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

pub fn parse_args<I, S>(args: I) -> Result<ParsedArgs, ParseError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut tokens = args
        .into_iter()
        .map(|value| value.as_ref().to_string())
        .peekable();
    if tokens
        .peek()
        .is_some_and(|token| token == "--version" || token == "-V")
    {
        return Ok(ParsedArgs::Command(LaunchCommand::Version));
    }

    let mut allow_lan = std::env::var("VIBEX_SERVER_ALLOW_LAN").as_deref() == Ok("1");
    let mut port = env_listen_port().unwrap_or(DEFAULT_PORT);
    let mut rotate_token = false;
    let mut reveal_console = false;
    let mut seen_local = false;

    if tokens
        .peek()
        .is_some_and(|token| token == "serve" || token == "web")
    {
        tokens.next();
        allow_lan = true;
        reveal_console = true;
    }

    if let Some(agents) = parse_agents_command(&mut tokens)? {
        return Ok(ParsedArgs::Agents(agents));
    }

    while let Some(token) = tokens.next() {
        match token.as_str() {
            "--help" | "-h" | "help" => return Ok(ParsedArgs::Command(LaunchCommand::Help)),
            "--version" | "-V" => return Ok(ParsedArgs::Command(LaunchCommand::Version)),
            "--lan" => allow_lan = true,
            "--local" => {
                allow_lan = false;
                seen_local = true;
            }
            "--rotate-token" => rotate_token = true,
            "--port" => {
                let value = tokens
                    .next()
                    .ok_or_else(|| ParseError("missing value for --port".to_string()))?;
                port = value
                    .parse()
                    .map_err(|_| ParseError(format!("invalid --port {value}")))?;
            }
            other if other.starts_with("--port=") => {
                let value = &other[7..];
                port = value
                    .parse()
                    .map_err(|_| ParseError(format!("invalid --port {value}")))?;
            }
            other => return Err(ParseError(format!("unknown argument: {other}"))),
        }
    }

    if seen_local {
        allow_lan = false;
    }

    Ok(ParsedArgs::Start(ServerLaunch {
        allow_lan,
        port,
        rotate_token,
        reveal_console,
    }))
}

pub fn usage() -> &'static str {
    "Usage:\n  \
     vibex-server                      Start on loopback\n  \
     vibex-server serve                Start the Web UI on the LAN and print the host token\n  \
     vibex-server serve --local        Start the Web UI on loopback only\n  \
     vibex-server serve --port N\n  \
     vibex-server serve --rotate-token\n  \
     vibex-server list [--json] [--refresh]\n  \
     vibex-server install <agent-id> [--yes]\n"
}

fn parse_agents_command<I>(
    tokens: &mut std::iter::Peekable<I>,
) -> Result<Option<AgentsCommand>, ParseError>
where
    I: Iterator<Item = String>,
{
    let Some(first) = tokens.peek() else {
        return Ok(None);
    };
    let command = match first.as_str() {
        "list" | "install" => tokens.next().expect("peeked"),
        "agents" => {
            tokens.next();
            tokens
                .next()
                .ok_or_else(|| ParseError("usage: vibex-server agents list|install".to_string()))?
        }
        _ => return Ok(None),
    };
    match command.as_str() {
        "list" => {
            let mut json = false;
            let mut refresh = false;
            while let Some(token) = tokens.next() {
                match token.as_str() {
                    "--json" => json = true,
                    "--refresh" => refresh = true,
                    "--help" | "-h" => {
                        return Err(ParseError(
                            "Usage: vibex-server list [--json] [--refresh]".to_string(),
                        ));
                    }
                    other => return Err(ParseError(format!("unknown list argument: {other}"))),
                }
            }
            Ok(Some(AgentsCommand::List { json, refresh }))
        }
        "install" => {
            let mut agent_id = None;
            let mut yes = false;
            while let Some(token) = tokens.next() {
                match token.as_str() {
                    "--yes" | "-y" => yes = true,
                    "-g" | "--global" => {}
                    "--help" | "-h" => {
                        return Err(ParseError(
                            "Usage: vibex-server install <agent-id> [--yes]".to_string(),
                        ));
                    }
                    other if other.starts_with('-') => {
                        return Err(ParseError(format!("unknown install argument: {other}")));
                    }
                    other if agent_id.is_none() => agent_id = Some(other.to_string()),
                    other => {
                        return Err(ParseError(format!("unexpected install argument: {other}")));
                    }
                }
            }
            let agent_id = agent_id.ok_or_else(|| {
                ParseError("Usage: vibex-server install <agent-id> [--yes]".to_string())
            })?;
            Ok(Some(AgentsCommand::Install { agent_id, yes }))
        }
        other => Err(ParseError(format!(
            "unknown agents command: {other} (expected list or install)"
        ))),
    }
}

fn env_listen_port() -> Option<u16> {
    std::env::var("VIBEX_SERVER_LISTEN")
        .ok()?
        .parse::<SocketAddr>()
        .ok()
        .map(|address| address.port())
        .or_else(|| {
            std::env::var("VIBEX_SERVER_LISTEN")
                .ok()?
                .parse::<u16>()
                .ok()
        })
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::{AgentsCommand, LaunchCommand, ParsedArgs, parse_args};

    #[test]
    fn serve_enables_lan_and_prints_the_console() {
        let ParsedArgs::Start(launch) = parse_args(["serve"]).expect("parse") else {
            panic!("expected start");
        };
        assert!(launch.allow_lan);
        assert!(launch.reveal_console);
        assert_eq!(launch.port, 17891);
        assert_eq!(launch.listen_addr().ip(), Ipv4Addr::UNSPECIFIED);
    }

    #[test]
    fn web_is_an_alias_for_serve() {
        let ParsedArgs::Start(launch) = parse_args(["web", "--port", "19000"]).expect("parse")
        else {
            panic!("expected start");
        };
        assert!(launch.allow_lan);
        assert_eq!(launch.port, 19000);
    }

    #[test]
    fn local_overrides_lan_for_loopback_only() {
        let ParsedArgs::Start(launch) = parse_args(["serve", "--local"]).expect("parse") else {
            panic!("expected start");
        };
        assert!(!launch.allow_lan);
        assert_eq!(launch.listen_addr().ip(), Ipv4Addr::LOCALHOST);
    }

    #[test]
    fn help_and_version_are_commands() {
        assert_eq!(
            parse_args(["--help"]).expect("parse"),
            ParsedArgs::Command(LaunchCommand::Help)
        );
        assert_eq!(
            parse_args(["help"]).expect("parse"),
            ParsedArgs::Command(LaunchCommand::Help)
        );
        assert_eq!(
            parse_args(["-V"]).expect("parse"),
            ParsedArgs::Command(LaunchCommand::Version)
        );
    }

    #[test]
    fn list_and_install_are_host_commands() {
        assert_eq!(
            parse_args(["list", "--refresh", "--json"]).expect("parse"),
            ParsedArgs::Agents(AgentsCommand::List {
                json: true,
                refresh: true,
            })
        );
        assert_eq!(
            parse_args(["install", "claude_code", "-y", "-g"]).expect("parse"),
            ParsedArgs::Agents(AgentsCommand::Install {
                agent_id: "claude_code".to_string(),
                yes: true,
            })
        );
        assert_eq!(
            parse_args(["agents", "install", "codex"]).expect("parse"),
            ParsedArgs::Agents(AgentsCommand::Install {
                agent_id: "codex".to_string(),
                yes: false,
            })
        );
    }

    #[test]
    fn install_requires_an_agent_id() {
        let error = parse_args(["install", "--yes"]).expect_err("missing id");
        assert!(error.to_string().contains("install <agent-id>"));
    }
}
