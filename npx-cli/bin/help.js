const { CLI_VERSION } = require('./download');

const TOPICS = {
  serve: `Usage: vibex serve [--port N] [--local] [--rotate-token]
       vibex web   (alias)

Start the Web UI. serve binds the LAN and prints the host token.
  --local           Loopback only
  --port N          Listen port (default 17891)
  --rotate-token    Replace the saved host token
`,

  list: `Usage: vibex list [--json] [--refresh]

List Agents the Host can install. Built-in Agents are grouped above
ACP Registry entries.
  --json            Print JSON
  --refresh         Fetch the official ACP Registry first
`,

  install: `Usage: vibex install <agent-id> [--yes]

Install the Agent Runtime and ACP into the user environment
(npm global prefix, uv tools, or ~/.local/bin).
  --yes, -y         Do not prompt
`,

  plugin: `Usage: vibex plugin pack [dir] [--output file.vxp]
       vibex plugin add <url> [--plugin ID] [--yes]

pack    Validate and write a .vxp
add     Install from a marketplace or GitHub URL
  --plugin ID     Choose one package when the archive has several
  --yes, -y       Install on the running Host without a prompt
        Looks up a local Host token if VIBEX_TOKEN is unset.
        If no Host is running, the .vxp stays in ~/.vibex/imports
        and Desktop imports it on the next launch.
`,

  conversation: `Usage: vibex conversation <command>
  create    --workspace ID --agent ID [--title T] [--prompt T]
  send      --conversation ID --workspace ID --agent ID --text T
  steer     --conversation ID --turn ID --text T
  child     --parent ID --agent ID [--title T] [--prompt T] [--hidden]
  show      --conversation ID
  relations --conversation ID
  wait      --conversation ID [--timeout S]
  cancel    --conversation ID [--reason T]
`,

  workflow: `Usage: vibex workflow <command>
  validate  --file FILE
  publish   --file FILE [--definition-id ID]
  run       --version ID --workspace ID [--input FILE] [--policy FILE]
  show      --run ID
  wait      --run ID [--timeout S]
  history   --run ID [--after N] [--limit N]
  cancel    --run ID [--reason T]
  resume    --run ID --decision retry|accept|skip|cancel [--step ID] [--output FILE]
`,

  project: `Usage: vibex project <command>
  list
  show    --id ID
  create  --name NAME [--path REPO]
  delete  --id ID
`,

  workspace: `Usage: vibex workspace <command>
  list [--project ID]
  show --id ID
`,

  session: `Usage: vibex session <command>
  list    --workspace ID
  show    --id ID
  create  --workspace ID [--agent ID] [--title T] [--prompt T]
          --project ID [--workspace ID] [--agent ID] [--title T] [--prompt T]
  delete  --id ID
`,

  file: `Usage: vibex file <command>
  tree   --path PATH [--depth N]
  read   --path PATH
  write  --path PATH (--text T | --file FILE)
`,

  git: `Usage: vibex git <command>
  status  --workspace ID --repo ID
  stage   --workspace ID --repo ID --path PATH
  commit  --workspace ID --repo ID --message T
`,

  agent: `Usage: vibex agent <command>
  list
`,
};

const ROOT = `Usage: vibex <command>

Host
  serve, web              Start the Web UI on the LAN and print the token
  list                    List built-in and ACP Registry Agents
  install <id> [-y]       Install Runtime and ACP on this Host
  (no command)            Start the Host on loopback
  --mcp                   Start vibex-mcp instead of vibex-server

Control (needs a running Host, VIBEX_URL, VIBEX_TOKEN)
  conversation            Create, send, wait, cancel
  workflow                Validate, publish, run, resume
  project, workspace, session
  file, git, agent

Other
  plugin pack             Package a .vxp
  plugin add <url>        Install a Plugin from marketplace or GitHub onto the local Host
  help [command]          This help
  --version, -V

${Object.keys(TOPICS)
  .map((topic) => `vibex help ${topic}`)
  .join('\n')}
`;

function text(topic) {
  if (!topic) return ROOT;
  const key = topic === 'web' ? 'serve' : topic;
  return TOPICS[key] || `Unknown command: ${topic}\n\n${ROOT}`;
}

function print(topic) {
  process.stdout.write(`${text(topic).trimEnd()}\n`);
}

function isHelp(args) {
  const [first, second] = args;
  return (
    first === 'help' ||
    first === '--help' ||
    first === '-h' ||
    second === '--help' ||
    second === '-h'
  );
}

function isVersion(args) {
  return args[0] === '--version' || args[0] === '-V' || args[0] === 'version';
}

function helpTopic(args) {
  if (args[0] === 'help') return args[1];
  if (args[0] === '--help' || args[0] === '-h') return args[1];
  if (args[1] === '--help' || args[1] === '-h') return args[0];
  return undefined;
}

function printVersion() {
  process.stdout.write(`${CLI_VERSION}\n`);
}

module.exports = {
  TOPICS,
  ROOT,
  text,
  print,
  printVersion,
  isHelp,
  isVersion,
  helpTopic,
};
