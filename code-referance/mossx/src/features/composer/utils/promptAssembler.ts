type SkillPromptInput = {
  name: string;
  description?: string;
};

type AssembleSinglePromptInput = {
  userInput: string;
  skills: SkillPromptInput[];
  commons: { name: string }[];
};

type AssemblePanelPromptInput = {
  workspaceQuestion: string;
  panelSkill: SkillPromptInput;
  inheritedCommons: { name: string }[];
  panelExtraInput?: string;
};

function toSlashToken(name: string) {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed) {
    return "";
  }
  return `/${trimmed.replace(/\s+/g, "-")}`;
}

export function shouldAssemblePrompt(input: {
  userInput: string;
  selectedSkillCount: number;
  selectedCommonsCount: number;
}) {
  const trimmed = input.userInput.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  return input.selectedSkillCount > 0 || input.selectedCommonsCount > 0;
}

export function assembleSinglePrompt(input: AssembleSinglePromptInput) {
  const userInput = input.userInput.trim();
  if (!userInput) {
    return "";
  }
  const tokens = [
    ...input.skills.map((skill) => toSlashToken(skill.name)).filter(Boolean),
    ...input.commons.map((common) => toSlashToken(common.name)).filter(Boolean),
  ];
  if (tokens.length === 0) {
    return userInput;
  }
  return `${tokens.join(" ")} ${userInput}`;
}

export function assemblePanelPrompt(input: AssemblePanelPromptInput) {
  const question = input.workspaceQuestion.trim();
  if (!question) {
    return "";
  }
  const tokens = [toSlashToken(input.panelSkill.name)];
  tokens.push(
    ...input.inheritedCommons.map((common) => toSlashToken(common.name)).filter(Boolean),
  );
  const extraInput = input.panelExtraInput?.trim();
  if (extraInput && !extraInput.startsWith("/")) {
    tokens.push(toSlashToken(extraInput));
  }
  const validTokens = tokens.filter(Boolean);
  if (validTokens.length === 0) {
    return question;
  }
  return `${validTokens.join(" ")} ${question}`;
}
