-- Deliberately retain the imported v2/control-plane tables for this schema
-- generation. V4 is the only production write path, but destructive retirement
-- is gated on a shipped-version parity audit plus a successful rollback
-- rehearsal against real upgraded databases. A later migration may drop these
-- read-only recovery tables after that release gate has produced evidence.
SELECT 1;
