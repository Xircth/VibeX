const SUPPORTED_EXTENSIONS = ['docx', 'xlsx', 'pptx'];
const SUPPORTED_MEDIA_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const WORKFLOW_IDS = [
  'create-presentation',
  'modify-presentation',
  'create-document',
  'modify-document',
  'analyze-spreadsheet',
  'generate-spreadsheet',
];

export default {
  apiVersion: '2.0',
  id: 'vibex.office',
  activate(ctx) {
    let idleTimeoutMinutes = 10;

    ctx.ui.registerSlashCommand({
      name: 'office-summary',
      description: 'Summarize or extract tables from DOCX, XLSX, or PPTX files',
      prompt:
        'Analyze the selected Office document and summarize key sections and tables.',
    });

    ctx.ui.registerCommand({
      id: 'vibex.office.preview',
      title: 'Preview Office Document',
      category: 'Office',
      icon: 'file-text',
      handler: async () => {
        ctx.events.emit('office:open-preview');
      },
    });

    ctx.ui.registerSettingsSection({
      id: 'office-settings',
      title: 'VibeX Office',
      description: 'Configure Office document preview idle timeout.',
      category: 'Tools',
      icon: 'file-text',
    });

    ctx.services.provide('vibex.office', {
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
      supportedMediaTypes: [...SUPPORTED_MEDIA_TYPES],
      workflows: [...WORKFLOW_IDS],
      supportsExtension(ext) {
        return SUPPORTED_EXTENSIONS.includes(
          String(ext ?? '')
            .toLowerCase()
            .replace(/^\./, '')
        );
      },
      getIdleTimeoutMinutes() {
        return idleTimeoutMinutes;
      },
      async setIdleTimeoutMinutes(minutes) {
        const clamped = Math.max(
          1,
          Math.min(60, Math.round(Number(minutes) || 10))
        );
        idleTimeoutMinutes = clamped;
        try {
          await ctx.storage.settings.set({ idleTimeoutMinutes: clamped });
        } catch {
          // Ignore if settings transport is unavailable.
        }
        return idleTimeoutMinutes;
      },
    });
  },
};
