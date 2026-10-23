const ALL_SCIENCE_DOMAINS = [
  'general',
  'literature',
  'writing',
  'stats',
  'infra',
  'singlecell',
  'genomics',
  'chemistry',
  'medicine',
  'physics',
];

export default {
  apiVersion: '2.0',
  id: 'vibex.science',
  activate(ctx) {
    const enabledDomainMap = {
      general: true,
      literature: false,
      writing: false,
      stats: false,
      infra: false,
      singlecell: false,
      genomics: false,
      chemistry: false,
      medicine: false,
      physics: false,
    };

    ctx.ui.registerSlashCommand({
      name: 'science-literature',
      description:
        'Synthesize primary scientific literature and experimental methodology',
      prompt:
        'Conduct a rigorous primary-source scientific review and methodology synthesis on:',
    });

    ctx.ui.registerCommand({
      id: 'vibex.science.configure-domains',
      title: 'Configure Scientific Skill Domains',
      category: 'Science',
      icon: 'flask-conical',
      handler: () => {
        ctx.events.emit('science:open-domain-settings', {
          domains: { ...enabledDomainMap },
        });
      },
    });

    ctx.ui.registerSettingsSection({
      id: 'science-domains',
      title: '科学研究领域',
      description: '按领域启用或停用 146 项科研技能包。',
      category: 'Skills',
      icon: 'flask-conical',
    });

    ctx.services.provide('vibex.science', {
      domains: ['general', 'genomics', 'dataScience'],
      allDomains: [...ALL_SCIENCE_DOMAINS],
      getEnabledDomains() {
        return ALL_SCIENCE_DOMAINS.filter((key) =>
          Boolean(enabledDomainMap[key])
        );
      },
      async setDomainEnabled(domain, enabled) {
        if (ALL_SCIENCE_DOMAINS.includes(domain)) {
          enabledDomainMap[domain] = Boolean(enabled);
          try {
            await ctx.storage.settings.set({
              domains: { ...enabledDomainMap },
            });
          } catch {
            // Ignore when settings transport is mocked.
          }
        }
        return { ...enabledDomainMap };
      },
    });
  },
};
