export default {
  apiVersion: '2.0',
  id: 'vibex.remote-ssh',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'ssh-connect',
      description: 'Diagnose or connect to a remote SSH VibeX Server host',
      prompt: 'Check SSH connectivity and remote VibeX Server status for host:',
    });

    ctx.services.provide('vibex.remote-ssh', {
      provisionKind: 'ssh',
    });
  },
};
