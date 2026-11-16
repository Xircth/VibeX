export const ROUNDTRIP = {
  manifest: {
    manifestVersion: 4,
    apiVersion: '2.0',
    id: 'dimo.session-enhance',
    publisher: 'dimo',
    version: '2.0.0',
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
      binaryId: 'dimo-mcp',
      product: 'session',
      protocolRevision: '2026-07-28',
      defaultBinding: 'all-compatible-agents',
    },
  },
};
