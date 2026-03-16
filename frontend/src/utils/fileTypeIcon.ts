import { createElement, FunctionComponentElement, SVGProps } from 'react';
import {
  File,
  FileText,
  FileCode,
  FileCode2,
  FileJson,
  Terminal,
  Database,
  Box,
  type LucideIcon,
} from 'lucide-react';

// Common interface for icon components used across the file tree
interface DeveloperIconProps extends Partial<SVGProps<SVGElement>> {
  size?: number;
}

type DeveloperIcon = (
  props: DeveloperIconProps
) => FunctionComponentElement<DeveloperIconProps>;

type IconMapping = {
  light: DeveloperIcon;
  dark: DeveloperIcon;
};

// Wrapper to adapt lucide-react icons to the DeveloperIcon interface
function wrapLucide(LucideComp: LucideIcon): DeveloperIcon {
  const wrapper: DeveloperIcon = ({ size, ...props }) => {
    return createElement(LucideComp, {
      size,
      ...(props as object),
    }) as unknown as FunctionComponentElement<DeveloperIconProps>;
  };
  return wrapper;
}

function icon(component: DeveloperIcon): IconMapping {
  return { light: component, dark: component };
}

// Lucide-based icon wrappers
const FileCodeIcon = wrapLucide(FileCode);
const FileCode2Icon = wrapLucide(FileCode2);
const FileTextIcon = wrapLucide(FileText);
const FileJsonIcon = wrapLucide(FileJson);
const TerminalIcon = wrapLucide(Terminal);
const DatabaseIcon = wrapLucide(Database);
const ContainerIcon = wrapLucide(Box);
const DefaultFileIcon = wrapLucide(File);

const extToIcon: Record<string, IconMapping> = {
  // TypeScript/JavaScript
  ts: icon(FileCode2Icon),
  tsx: icon(FileCode2Icon),
  js: icon(FileCode2Icon),
  mjs: icon(FileCode2Icon),
  cjs: icon(FileCode2Icon),
  jsx: icon(FileCode2Icon),

  // Web
  html: icon(FileCodeIcon),
  htm: icon(FileCodeIcon),
  css: icon(FileCodeIcon),
  scss: icon(FileCodeIcon),
  sass: icon(FileCodeIcon),
  less: icon(FileCodeIcon),

  // Frameworks
  vue: icon(FileCode2Icon),
  svelte: icon(FileCode2Icon),

  // Languages
  py: icon(FileCode2Icon),
  rs: icon(FileCode2Icon),
  go: icon(FileCode2Icon),
  java: icon(FileCode2Icon),
  c: icon(FileCode2Icon),
  h: icon(FileCode2Icon),
  cpp: icon(FileCode2Icon),
  cc: icon(FileCode2Icon),
  cxx: icon(FileCode2Icon),
  hpp: icon(FileCode2Icon),
  cs: icon(FileCode2Icon),
  swift: icon(FileCode2Icon),
  kt: icon(FileCode2Icon),
  dart: icon(FileCode2Icon),
  rb: icon(FileCode2Icon),
  php: icon(FileCode2Icon),
  lua: icon(FileCode2Icon),
  r: icon(FileCode2Icon),
  scala: icon(FileCode2Icon),
  ex: icon(FileCode2Icon),
  exs: icon(FileCode2Icon),

  // Data/Config
  json: icon(FileJsonIcon),
  md: icon(FileTextIcon),
  yaml: icon(FileJsonIcon),
  yml: icon(FileJsonIcon),

  // Shell
  sh: icon(TerminalIcon),
  bash: icon(TerminalIcon),
  zsh: icon(TerminalIcon),
  ps1: icon(TerminalIcon),

  // Databases
  sql: icon(DatabaseIcon),
  psql: icon(DatabaseIcon),

  // Special files
  graphql: icon(FileCode2Icon),
  gql: icon(FileCode2Icon),
};

// Special filename mappings (for files without extensions)
const filenameToIcon: Record<string, IconMapping> = {
  dockerfile: icon(ContainerIcon),
  'docker-compose.yml': icon(ContainerIcon),
  'docker-compose.yaml': icon(ContainerIcon),
  '.angular.json': icon(FileCode2Icon),
};

export function getFileIcon(
  filename: string,
  theme: 'light' | 'dark'
): DeveloperIcon {
  const lowerFilename = filename.toLowerCase();

  // Check special filenames first
  const basename = lowerFilename.split('/').pop() || '';
  const filenameMapping = filenameToIcon[basename];
  if (filenameMapping) {
    return filenameMapping[theme];
  }

  // Then check extension
  const ext = basename.split('.').pop() || '';
  const extMapping = extToIcon[ext];
  if (extMapping) {
    return extMapping[theme];
  }

  return DefaultFileIcon;
}
