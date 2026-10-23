export default {
  apiVersion: '2.0',
  id: 'vibex.office',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'office-summary',
      description: 'Summarize or extract tables from DOCX, XLSX, or PPTX files',
      prompt: 'Analyze the selected Office document and summarize key sections and tables.',
    });

    ctx.services.provide('vibex.office', {
      supportedExtensions: ['docx', 'xlsx', 'pptx'],
      supportsExtension(ext) {
        return ['docx', 'xlsx', 'pptx'].includes(String(ext).toLowerCase().replace(/^\./, ''));
      },
    });
  },
};
