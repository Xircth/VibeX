import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('kanban usage dashboard keeps cached query data warm across scope and date-range switches', () => {
  const source = readFile('src/components/kanban/KanbanUsageDashboard.tsx');

  assert.match(source, /useQuery,\s*useQueryClient/);
  assert.match(source, /getUsageStatisticsQueryOptions/);
  assert.match(
    source,
    /queryKey: \['kanbanUsageStatistics', target, dateRange\]/
  );
  assert.match(source, /placeholderData:/);
  assert.match(source, /availableTargets\.flatMap/);
  assert.match(source, /prefetchQuery\(/);
  assert.match(source, /startTransition\(/);
  assert.match(source, /statisticsQuery\.refetch\(\)/);
  assert.doesNotMatch(source, /const \[loading,\s*setLoading\]/);
  assert.doesNotMatch(source, /const \[statistics,\s*setStatistics\]/);
});

test('session hub monitor cards keep time inline and avoid backend display-name fallbacks', () => {
  const source = readFile(
    'src/components/kanban/session-hub/SessionHubMonitor.tsx'
  );
  const hookSource = readFile('src/hooks/useKanbanProjectSessions.ts');

  assert.match(source, /className="flex min-w-0 items-baseline gap-2"/);
  assert.match(source, /formatTimeAgo\(session\.updatedAt\)/);
  assert.doesNotMatch(source, /session\.workspaceDisplayLabel/);
  assert.doesNotMatch(source, /createSessionSnapshot/);
  assert.doesNotMatch(source, /initialSession=/);
  assert.doesNotMatch(source, /initialWorkspace=/);
  assert.match(hookSource, /name: '会话'/);
  assert.doesNotMatch(
    hookSource,
    /name: summary\.display_name\?\.trim\(\) \|\| '会话'/
  );
});
