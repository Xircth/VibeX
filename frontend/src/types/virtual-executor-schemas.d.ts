declare module 'virtual:executor-schemas' {
  import type { RJSFSchema } from '@rjsf/utils';
  import type { AgentKind } from '@/shared/types';

  const schemas: Record<AgentKind, RJSFSchema>;
  export { schemas };
  export default schemas;
}
