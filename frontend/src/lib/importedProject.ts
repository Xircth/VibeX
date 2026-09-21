export function importedProjectName(
  project: { name: string; is_home?: boolean },
  t: (key: string) => string
): string {
  return project.is_home ? t('welcomePage.globalProject') : project.name;
}

export function orderImportedProjects<
  T extends { is_home?: boolean; parent_project_id?: string | null },
>(projects: T[]): T[] {
  const home = projects.filter((project) => project.is_home);
  const rest = projects.filter((project) => !project.is_home);
  return [...home, ...rest];
}
