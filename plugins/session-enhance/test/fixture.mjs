export const ROUNDTRIP = {
  manifest: {
    manifestVersion: 4,
    apiVersion: '1.0',
    id: 'vibex.session-enhance',
    publisher: 'vibex',
    version: '1.0.0',
    name: '会话增强',
  },
  config: {
    feedback: true,
    question: true,
    sessionInfo: true,
    sessionControl: true,
  },
  mcp: {
    managedRuntime: {
      kind: 'hostFamilyBinary',
      binaryId: 'vibex-mcp',
      product: 'session',
      protocolRevision: '2026-07-28',
      defaultBinding: 'all-compatible-agents',
    },
  },
};
