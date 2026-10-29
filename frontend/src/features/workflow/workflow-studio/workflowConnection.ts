import { confirmationParentId } from './types';

export function isWorkflowConnectionValid(connection: {
  source: string | null;
  target: string | null;
}) {
  if (!connection.source || !connection.target) return false;
  if (connection.source === connection.target) return false;
  const sourceParent =
    confirmationParentId(connection.source) ?? connection.source;
  const targetParent =
    confirmationParentId(connection.target) ?? connection.target;
  if (
    connection.target === `confirmation:${sourceParent}` ||
    connection.source === `confirmation:${targetParent}`
  ) {
    return true;
  }
  return sourceParent !== targetParent;
}
