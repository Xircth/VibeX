export interface GitHostErrorPresentation {
  title: string;
  hint?: string;
}

function normalizeErrorMessage(error: string | null | undefined): string {
  return (error ?? '').trim();
}

export function getGitHostErrorPresentation(
  error: string | null | undefined,
  subject: 'Issues' | 'PRs'
): GitHostErrorPresentation | null {
  const message = normalizeErrorMessage(error);
  if (!message) {
    return null;
  }

  const lowered = message.toLowerCase();

  if (lowered.includes('no remotes configured')) {
    return {
      title: `无法加载${subject}：当前仓库还没有配置远程仓库。`,
      hint: '解决方法：先为仓库添加 origin 等远程地址，例如执行 git remote add origin <仓库地址>，然后再点击刷新。',
    };
  }

  if (lowered.includes('invalid repository')) {
    return {
      title: `无法加载${subject}：当前仓库的 Git 远程配置无效。`,
      hint: '解决方法：确认仓库已初始化、已配置可用远程地址，并且当前项目目录指向正确仓库后再重试。',
    };
  }

  return {
    title: `无法加载${subject}。`,
    hint: message,
  };
}
