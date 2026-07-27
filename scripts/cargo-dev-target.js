const fs = require('fs');
const path = require('path');

function resetCargoDebugTarget(workspaceRoot) {
  const debugTarget = path.resolve(workspaceRoot, 'target', 'debug');

  if (!fs.existsSync(debugTarget)) {
    return false;
  }

  const targetStat = fs.lstatSync(debugTarget);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(
      `Refusing to remove unsafe Cargo debug target: ${debugTarget}`
    );
  }

  fs.rmSync(debugTarget, {
    force: false,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });
  return true;
}

module.exports = { resetCargoDebugTarget };
