import { describe, expect, it } from 'vitest';
import {
  buildTagReferenceAppendix,
  materializePromptTagReferences,
  parseTagReferenceHref,
  parseTagReferenceMarker,
  replaceTagReferenceMarkersWithMarkdownLinks,
  serializeTagReferenceMarker,
  stripTagReferenceAppendix,
} from './tagReferenceMarkers';

describe('tagReferenceMarkers', () => {
  const payload = {
    tagId: 'tag-1',
    tagName: '启动项目开发服务器',
    content: '先检查依赖，再启动开发服务器，并返回可访问 URL。',
  };

  it('round-trips serialized markers', () => {
    const marker = serializeTagReferenceMarker(payload);

    expect(parseTagReferenceMarker(marker)).toEqual(payload);
  });

  it('builds markdown links for history rendering', () => {
    const marker = serializeTagReferenceMarker(payload);

    expect(
      replaceTagReferenceMarkersWithMarkdownLinks(`请执行 ${marker}`)
    ).toBe(
      `请执行 [#${payload.tagName}](tag-ref://${encodeURIComponent(
        JSON.stringify(payload)
      )})`
    );
  });

  it('materializes and strips tag appendices without changing the visible body', () => {
    const marker = serializeTagReferenceMarker(payload);
    const rawMessage = `请先处理 ${marker} 然后继续`;
    const appendix = buildTagReferenceAppendix(rawMessage);
    const materialized = materializePromptTagReferences(rawMessage);

    expect(appendix).toContain(`[#${payload.tagName}]:`);
    expect(materialized).toContain(rawMessage);
    expect(stripTagReferenceAppendix(materialized)).toBe(rawMessage);
  });

  it('parses tag-ref href payloads for markdown chip rendering', () => {
    const href = `tag-ref://${encodeURIComponent(JSON.stringify(payload))}`;

    expect(parseTagReferenceHref(href)).toEqual(payload);
  });
});
