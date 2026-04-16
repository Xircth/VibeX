export const EMPTY_DIRECTORIES: string[] = [];
export const EMPTY_SET: Set<string> = new Set();

export const SPECIAL_DEPENDENCY_DIRECTORIES = new Set([
  'node_modules',
  '.pnpm-store',
  '.yarn',
  'bower_components',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pypackages__',
  'Pods',
  'Carthage',
  '.m2',
  '.ivy2',
  '.cargo',
]);

export const SPECIAL_BUILD_ARTIFACT_DIRECTORIES = new Set([
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.parcel-cache',
  '.turbo',
  '.cache',
  '.gradle',
  'CMakeFiles',
  'bin',
  'obj',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.dart_tool',
]);

export const imageExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'heic',
  'heif',
  'tif',
  'tiff',
]);
