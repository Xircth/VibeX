export function getComposerSteeringTarget(args: {
  isTurnInFlight: boolean;
  steeringSupported: boolean;
  currentTurnId: string | null;
}): { turnId: string } | null {
  if (!args.isTurnInFlight || !args.steeringSupported || !args.currentTurnId) {
    return null;
  }
  return { turnId: args.currentTurnId };
}
