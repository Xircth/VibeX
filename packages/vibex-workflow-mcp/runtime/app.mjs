import { definePluginApp } from '@vibex/plugin-sdk/app';
import './app.css';

/**
 * Compatibility document for Hosts that understand App surfaces but predate
 * the public `workflow.studio` native renderer. Current VibeX never mounts this
 * document: the plugin registers the artifact type and the Host supplies the
 * shared WorkflowStudio implementation.
 */
export default definePluginApp(({ bridge, root, signal }) => {
  root.innerHTML = `
    <main class="compatibility">
      <div class="mark" aria-hidden="true">⌘</div>
      <h1>Workflow Studio requires a newer VibeX Host</h1>
      <p>Update VibeX to edit this workflow with the shared native Studio.</p>
    </main>`;
  bridge.ready();
  signal.addEventListener(
    'abort',
    () => {
      root.innerHTML = '';
    },
    { once: true }
  );
});
