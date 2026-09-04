import { definePluginApp } from '@vibex/plugin-sdk/app';
import './app.css';

export default definePluginApp(({ root, bridge }) => {
  root.innerHTML =
    '<section class="surface"><h1>结构面示例</h1><p>这是用公开 SDK 贡献的示例面。</p></section>';
  bridge.ready();
  return () => {
    root.innerHTML = '';
  };
});
