import assert from 'node:assert/strict';
import test from 'node:test';

import { ROUNDTRIP } from './fixture.mjs';

test('v4 manifest, session skill, and gated host-family MCP', () => {
  assert.equal(ROUNDTRIP.manifest.manifestVersion, 4);
  assert.equal(ROUNDTRIP.manifest.apiVersion, '1.0');
  assert.equal(ROUNDTRIP.manifest.id, 'vibex.session-enhance');
  assert.equal(ROUNDTRIP.manifest.publisher, 'vibex');
  assert.equal(ROUNDTRIP.manifest.version, '1.0.0');
  assert.equal(ROUNDTRIP.config.feedback, true);
  assert.equal(ROUNDTRIP.config.question, true);
  assert.equal(ROUNDTRIP.config.sessionInfo, true);
  assert.equal(ROUNDTRIP.config.sessionControl, true);
  assert.equal(ROUNDTRIP.mcp.managedRuntime.kind, 'hostFamilyBinary');
  assert.equal(ROUNDTRIP.mcp.managedRuntime.binaryId, 'vibex-mcp');
  assert.equal(ROUNDTRIP.mcp.managedRuntime.product, 'session');
  assert.equal(ROUNDTRIP.mcp.managedRuntime.protocolRevision, '2026-07-28');
});
