export default {
  apiVersion: '2.0',
  id: 'vibex-plugin-computer-use',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'computer-use',
      description: 'Inspect or automate a desktop application window',
      prompt: 'Use the Computer Use accessibility snapshot and window tools to:',
    });

    ctx.services.provide('vibex.computer-use', {
      emergencyStopHotkey: 'Ctrl+Alt+Escape',
    });
  },
};
