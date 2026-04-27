export interface TagReferenceMarkerPayload {
  tagId: string;
  tagName: string;
  content: string;
}

const TAG_REFERENCE_MARKER_PREFIX = '[[tag:';
const TAG_REFERENCE_MARKER_SUFFIX = ']]';
const TAG_REFERENCE_MARKER_PATTERN = '\\[\\[tag:([^\\[\\]]+)\\]\\]';
const TAG_REFERENCE_APPENDIX_HEADER = '---\nReferenced tags:\n';

function getTagReferenceMarkerRegex(flags = '') {
  return new RegExp(TAG_REFERENCE_MARKER_PATTERN, flags);
}

function parseEncodedPayload(
  encodedPayload: string
): TagReferenceMarkerPayload | null {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(encodedPayload)
    ) as Partial<TagReferenceMarkerPayload>;

    if (
      typeof parsed.tagId !== 'string' ||
      typeof parsed.tagName !== 'string' ||
      typeof parsed.content !== 'string'
    ) {
      return null;
    }

    return {
      tagId: parsed.tagId,
      tagName: parsed.tagName,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

export function serializeTagReferenceMarker(
  payload: TagReferenceMarkerPayload
): string {
  return `${TAG_REFERENCE_MARKER_PREFIX}${encodeURIComponent(
    JSON.stringify(payload)
  )}${TAG_REFERENCE_MARKER_SUFFIX}`;
}

export function parseTagReferenceMarker(
  marker: string
): TagReferenceMarkerPayload | null {
  const match = marker.trim().match(getTagReferenceMarkerRegex());
  if (!match?.[1]) {
    return null;
  }

  return parseEncodedPayload(match[1]);
}

export function parseTagReferenceHref(
  href: string
): TagReferenceMarkerPayload | null {
  if (!href.startsWith('tag-ref://')) {
    return null;
  }

  return parseEncodedPayload(href.slice('tag-ref://'.length));
}

export function replaceTagReferenceMarkersWithMarkdownLinks(input: string) {
  return input.replace(getTagReferenceMarkerRegex('g'), (fullMatch, encoded) => {
    const payload = parseEncodedPayload(encoded);
    if (!payload) {
      return fullMatch;
    }

    return `[#${payload.tagName}](tag-ref://${encoded})`;
  });
}

export function extractTagReferencePayloads(
  input: string
): TagReferenceMarkerPayload[] {
  const payloads: TagReferenceMarkerPayload[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(getTagReferenceMarkerRegex('g'))) {
    const encodedPayload = match[1];
    if (!encodedPayload || seen.has(encodedPayload)) {
      continue;
    }

    const payload = parseEncodedPayload(encodedPayload);
    if (!payload) {
      continue;
    }

    seen.add(encodedPayload);
    payloads.push(payload);
  }

  return payloads;
}

function buildExpandedTagBlock(payload: TagReferenceMarkerPayload) {
  if (!payload.content.trim()) {
    return `#${payload.tagName}`;
  }

  return `[#${payload.tagName}]:\n${payload.content}`;
}

export function buildTagReferenceAppendix(input: string): string | null {
  const payloads = extractTagReferencePayloads(input);
  if (payloads.length === 0) {
    return null;
  }

  return `${TAG_REFERENCE_APPENDIX_HEADER}${payloads
    .map(buildExpandedTagBlock)
    .join('\n\n')}`;
}

export function materializePromptTagReferences(input: string): string {
  const appendix = buildTagReferenceAppendix(input);
  if (!appendix) {
    return input;
  }

  return `${input}\n\n${appendix}`;
}

export function stripTagReferenceAppendix(input: string): string {
  const appendix = buildTagReferenceAppendix(input);
  if (!appendix) {
    return input;
  }

  const suffix = `\n\n${appendix}`;
  if (input.endsWith(suffix)) {
    return input.slice(0, -suffix.length);
  }

  return input;
}
