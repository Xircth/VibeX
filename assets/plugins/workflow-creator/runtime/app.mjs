import { definePluginApp } from '@vibex/plugin-sdk/app';
import './app.css';

/** Fallback page if this Host cannot mount native Workflow Studio. */
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
