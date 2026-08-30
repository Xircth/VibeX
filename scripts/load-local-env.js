const fs = require('fs');

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseLocalEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const assignment = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    parsed[key] = stripQuotes(assignment.slice(separator + 1).trim());
  }
  return parsed;
}

function applyLocalEnvFile(filePath, env = process.env) {
  const next = { ...env };
  for (const [key, value] of Object.entries(parseLocalEnvFile(filePath))) {
    if (next[key] === undefined || next[key] === '') {
      next[key] = value;
    }
  }
  return next;
}

module.exports = {
  applyLocalEnvFile,
  parseLocalEnvFile,
};
