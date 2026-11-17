import common from './common.json';
import settings from './settings.json';
import statusbar from './statusbar.json';
import app from './app.json';
import tasks from './tasks.json';
import dialogs from './dialogs.json';
import conversation from './conversation.json';
import panels from './panels.json';
import workflow from './workflow.json';
import basicGuide from './basicGuide.json';

const enBundle = {
  common,
  settings,
  statusbar,
  app,
  tasks,
  dialogs,
  conversation,
  panels,
  workflow,
  basicGuide,
} as const;

export default enBundle;
