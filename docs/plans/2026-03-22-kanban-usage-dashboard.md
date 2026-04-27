# Kanban Usage Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 鍦?Kanban 椤甸潰鏂板绗笁娈碘€滆閲忕粺璁＄湅鏉库€濊鍥撅紝鏀寔閫氳繃鍙充晶绠ご浠庘€滀細璇濆垪琛?鐩戞帶鈥濆垏鎹㈣繘鍏ワ紝骞跺熀浜庡綋鍓嶉」鐩笅鍏ㄩ儴 workspace 鐨?ClaudeCode銆丆odex銆丱penCode 鏈湴鍘嗗彶鏂囦欢鑱氬悎 Token 涓庤垂鐢ㄧ粺璁°€?

**Architecture:** 鍓嶇灏?`DockviewKanbanPanel` 鐨勫弻灞忔粦鍔ㄩ噸鏋勪负涓夊睆鏋氫妇鐘舵€侊紱鍚庣鏂板椤圭洰绾?usage 鑱氬悎鍛戒护锛屾寜 `projectId` 鏀堕泦 workspace 璺緞锛屽啀閫傞厤澶嶇敤 `mossx` 鐨勬湰鍦?usage 鎵弿閫昏緫锛涘墠绔柊澧?Kanban 涓撶敤 usage 闈㈡澘锛屽鐢?`mossx` 鐨勫洓鏍囩椤电粨鏋勪笌鏁版嵁鏄犲皠鎬濊矾銆?

**Tech Stack:** Tauri commands, Rust, ts-rs, React, TypeScript, TanStack Query, Vitest, Tailwind/shadcn

---

### Task 1: 瀹氫箟椤圭洰绾?usage 绫诲瀷涓庡悗绔懡浠ら鏋?

**Files:**
- Create: `src-tauri/src/commands/local_usage.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bin/generate_types.rs`
- Test: `src-tauri/src/commands/local_usage.rs`

**Step 1: 鍐欏け璐ユ祴璇曪紝瀹氫箟绌洪」鐩笌鍩虹鑱氬悎杈撳嚭**

鍦?`src-tauri/src/commands/local_usage.rs` 搴曢儴鏂板 `#[cfg(test)]`锛屽厛鍐欐渶灏忓崟娴嬶細

```rust
#[test]
fn build_empty_project_usage_statistics_returns_zeroed_result() {
    let result = build_project_usage_statistics(
        "project-1".to_string(),
        "Demo".to_string(),
        Vec::new(),
        Vec::new(),
        0,
    );

    assert_eq!(result.project_id, "project-1");
    assert_eq!(result.total_sessions, 0);
    assert_eq!(result.estimated_cost, 0.0);
    assert!(result.sessions.is_empty());
}
```

**Step 2: 杩愯娴嬭瘯锛岀‘璁ゅけ璐?*

Run: `cargo test build_empty_project_usage_statistics_returns_zeroed_result --package vibex`

Expected: FAIL锛屾彁绀哄嚱鏁版垨绫诲瀷灏氭湭瀹氫箟銆?

**Step 3: 鍐欐渶灏忓疄鐜?*

鍦?`src-tauri/src/commands/local_usage.rs` 涓細

- 瀹氫箟 `ProjectUsageStatistics`
- 瀹氫箟 `ProjectUsageProviderStatus`
- 瀹氫箟鍩虹 `build_project_usage_statistics(...)`
- 浣跨敤 `#[derive(Serialize, TS)]`

鍚屾椂鍦細

- `src-tauri/src/commands/mod.rs` 娉ㄥ唽 `pub mod local_usage;`
- `src-tauri/src/lib.rs` 娉ㄥ唽 Tauri command
- `src-tauri/src/bin/generate_types.rs` 娣诲姞鏂扮被鍨嬪鍑?

**Step 4: 杩愯娴嬭瘯锛岀‘璁ら€氳繃**

Run: `cargo test build_empty_project_usage_statistics_returns_zeroed_result --package vibex`

Expected: PASS

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add src-tauri/src/commands/local_usage.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/bin/generate_types.rs
git commit -m "feat: add project usage command skeleton"
```

### Task 2: 閫傞厤骞跺疄鐜伴」鐩骇鏈湴 usage 鑱氬悎

**Files:**
- Modify: `src-tauri/src/commands/local_usage.rs`
- Modify: `src-tauri/src/commands/projects.rs`
- Test: `src-tauri/src/commands/local_usage.rs`

**Step 1: 鍐欏け璐ユ祴璇曪紝瑕嗙洊澶?workspace 鑱氬悎涓?provider 鐘舵€?*

鍦?`src-tauri/src/commands/local_usage.rs` 鏂板娴嬭瘯锛?

```rust
#[test]
fn merge_provider_sessions_combines_multiple_workspaces() {
    let sessions = vec![
        fake_session("a", "gpt-5", 1000, 0.12, 100),
        fake_session("b", "claude-sonnet", 2000, 0.34, 200),
    ];

    let result = build_project_usage_statistics(
        "project-1".to_string(),
        "Demo".to_string(),
        sessions,
        vec![provider_ok("codex"), provider_ok("claude"), provider_failed("opencode", "timeout")],
        123,
    );

    assert_eq!(result.total_sessions, 2);
    assert_eq!(result.provider_status.len(), 3);
    assert_eq!(result.by_model.len(), 2);
}
```

**Step 2: 杩愯娴嬭瘯锛岀‘璁ゅけ璐?*

Run: `cargo test merge_provider_sessions_combines_multiple_workspaces --package vibex`

Expected: FAIL锛屾彁绀鸿緟鍔╂瀯閫犲嚱鏁版垨鑱氬悎瀛楁涓嶅畬鏁淬€?

**Step 3: 鍐欐渶灏忓疄鐜?*

鍦?`src-tauri/src/commands/local_usage.rs` 涓疄鐜帮細

- 椤圭洰涓?workspace 璺緞鏀堕泦閫昏緫
- provider 閫愪釜鎵弿
- 鑱氬悎 `sessions / daily_usage / by_model / weekly_comparison`
- 閮ㄥ垎 provider 澶辫触鏃惰褰曞埌 `provider_status`
- `get_project_usage_statistics(project_id, date_range)` Tauri command

瀹炵幇鏃跺弬鑰冿細

- `code-referance/mossx/src-tauri/src/local_usage.rs`
- `src-tauri/src/commands/projects.rs`

瑕佹眰锛?

- 浣跨敤 `spawn_blocking`
- 涓嶅洜鍗曚釜 provider 澶辫触瀵艰嚧鏁翠綋澶辫触
- 鏃ユ湡鑼冨洿鍙敮鎸?`7d | 30d | all`

**Step 4: 杩愯娴嬭瘯锛岀‘璁ら€氳繃**

Run: `cargo test project_usage --package vibex`

Expected: PASS锛屾柊澧?usage 鐩稿叧娴嬭瘯鍏ㄩ儴閫氳繃銆?

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add src-tauri/src/commands/local_usage.rs src-tauri/src/commands/projects.rs
git commit -m "feat: add project usage aggregation"
```

### Task 3: 鐢熸垚鍏变韩绫诲瀷骞舵帴鍏ュ墠绔?API

**Files:**
- Create: `frontend/src/lib/api/localUsage.ts`
- Modify: `frontend/src/lib/api/index.ts`
- Modify: `shared/types.ts`
- Test: `shared/types.ts`

**Step 1: 鍐欏け璐ユ祴璇曟垨绫诲瀷浣跨敤鐐癸紝鍏堣鍓嶇寮曠敤涓嶅瓨鍦ㄧ殑 API**

鍦ㄦ柊鏂囦欢 `frontend/src/lib/api/localUsage.ts` 涓厛寮曠敤灏氫笉瀛樺湪鐨勭被鍨嬶細

```ts
import type { ProjectUsageStatistics } from 'shared/types';

export const localUsageApi = {
  getProjectStatistics: async (
    projectId: string,
    dateRange: '7d' | '30d' | 'all'
  ): Promise<ProjectUsageStatistics> => {
    throw new Error('not implemented');
  },
};
```

**Step 2: 杩愯绫诲瀷鐢熸垚妫€鏌ワ紝纭澶辫触鎴栫己灏戠被鍨?*

Run: `pnpm run generate-types:check`

Expected: FAIL锛屾彁绀烘柊绫诲瀷灏氭湭瀵煎嚭锛屾垨鍓嶇绫诲瀷涓嶅彲鐢ㄣ€?

**Step 3: 鍐欐渶灏忓疄鐜?*

- 杩愯 `pnpm run generate-types`
- 鍦?`frontend/src/lib/api/localUsage.ts` 涓皟鐢?`tauriInvoke('get_project_usage_statistics', ...)`
- 鍦?`frontend/src/lib/api/index.ts` 涓鍑?`localUsageApi`

娉ㄦ剰锛?

- 涓嶆墜鏀?`shared/types.ts`
- 浠呴€氳繃 `src-tauri/src/bin/generate_types.rs` 椹卞姩鐢熸垚

**Step 4: 杩愯妫€鏌ワ紝纭閫氳繃**

Run:

```bash
pnpm run generate-types:check
pnpm run check
```

Expected: PASS

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add frontend/src/lib/api/localUsage.ts frontend/src/lib/api/index.ts src-tauri/src/bin/generate_types.rs shared/types.ts
git commit -m "feat: expose project usage api"
```

### Task 4: 鎶界涓夋寮?Kanban 瑙嗗浘鐘舵€?

**Files:**
- Create: `frontend/src/lib/kanbanPanelView.ts`
- Create: `frontend/src/lib/kanbanPanelView.test.ts`
- Modify: `frontend/src/contexts/KanbanSessionContext.tsx`
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`

**Step 1: 鍐欏け璐ユ祴璇曪紝瀹氫箟涓夋寮忓垏鎹㈣鍒?*

鍦?`frontend/src/lib/kanbanPanelView.test.ts` 鍐欐祴璇曪細

```ts
import { describe, expect, it } from 'vitest';
import {
  getNextKanbanPanelView,
  getPreviousKanbanPanelView,
} from './kanbanPanelView';

describe('kanbanPanelView', () => {
  it('moves forward from board to session hub to usage dashboard', () => {
    expect(getNextKanbanPanelView('board')).toBe('sessionHub');
    expect(getNextKanbanPanelView('sessionHub')).toBe('usageDashboard');
  });

  it('moves backward from usage dashboard to session hub to board', () => {
    expect(getPreviousKanbanPanelView('usageDashboard')).toBe('sessionHub');
    expect(getPreviousKanbanPanelView('sessionHub')).toBe('board');
  });
});
```

**Step 2: 杩愯娴嬭瘯锛岀‘璁ゅけ璐?*

Run: `pnpm vitest frontend/src/lib/kanbanPanelView.test.ts`

Expected: FAIL锛屾彁绀烘ā鍧椾笉瀛樺湪銆?

**Step 3: 鍐欐渶灏忓疄鐜?*

- 鏂板缓 `frontend/src/lib/kanbanPanelView.ts`
- 瀵煎嚭 `KanbanPanelView = 'board' | 'sessionHub' | 'usageDashboard'`
- 鎻愪緵鍓嶈繘/鍚庨€€绾嚱鏁?
- 鍦?`frontend/src/contexts/KanbanSessionContext.tsx` 涓敤鏋氫妇鐘舵€佹浛浠?`isSessionHubVisible`
- 鍦?`frontend/src/components/panels/DockviewKanbanPanel.tsx` 涓妸婊戝姩瀹藉害浠?`200%` 鏀逛负 `300%`

**Step 4: 杩愯娴嬭瘯锛岀‘璁ら€氳繃**

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts
pnpm run check
```

Expected: PASS

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add frontend/src/lib/kanbanPanelView.ts frontend/src/lib/kanbanPanelView.test.ts frontend/src/contexts/KanbanSessionContext.tsx frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "refactor: add three-stage kanban panel state"
```

### Task 5: 鏋勫缓 Kanban usage 鐪嬫澘 UI

**Files:**
- Create: `frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.tsx`
- Create: `frontend/src/components/kanban/kanban-usage/usageFormatting.ts`
- Create: `frontend/src/hooks/useProjectUsageStatistics.ts`
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`
- Test: `frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx`

**Step 1: 鍐欏け璐ユ祴璇曪紝瀹氫箟鍩虹娓叉煋**

鍦?`frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx` 涓啓鏈€灏忔祴璇曪細

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KanbanUsageDashboard } from './KanbanUsageDashboard';

describe('KanbanUsageDashboard', () => {
  it('renders four tabs', () => {
    render(<KanbanUsageDashboard projectId="p1" />);
    expect(screen.getByRole('tab', { name: '姒傝' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '妯″瀷' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '浼氳瘽' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '鏃堕棿绾? })).toBeInTheDocument();
  });
});
```

**Step 2: 杩愯娴嬭瘯锛岀‘璁ゅけ璐?*

Run: `pnpm vitest frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx`

Expected: FAIL锛屾彁绀虹粍浠朵笉瀛樺湪銆?

**Step 3: 鍐欐渶灏忓疄鐜?*

- `useProjectUsageStatistics.ts`锛氬皝瑁?TanStack Query
- `KanbanUsageDashboard.tsx`锛氬疄鐜板洓鏍囩椤?
- `usageFormatting.ts`锛氭斁 `formatNumber / formatCost / formatDate`
- 鍏堝畬鎴愶細
  - 姒傝鍗＄墖
  - 妯″瀷鎺掕
  - 浼氳瘽鍒嗛〉鍒楄〃
  - 鏃堕棿绾挎煴鐘跺浘
- 鍦?`DockviewKanbanPanel.tsx` 涓寕杞界涓夊睆鍐呭

鏍峰紡瑕佹眰锛?

- 浣跨敤褰撳墠椤圭洰鐜版湁 Tailwind / shadcn 椋庢牸
- 涓嶇洿鎺ュ鍒?`mossx` 鐨?settings CSS

**Step 4: 杩愯娴嬭瘯锛岀‘璁ら€氳繃**

Run:

```bash
pnpm vitest frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx
pnpm run check
```

Expected: PASS

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.tsx frontend/src/components/kanban/kanban-usage/usageFormatting.ts frontend/src/hooks/useProjectUsageStatistics.ts frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "feat: add kanban usage dashboard"
```

### Task 6: 鎺ュ叆绠ご浜や簰涓庡洖褰掗獙璇?

**Files:**
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`
- Modify: `frontend/src/contexts/KanbanSessionContext.tsx`
- Test: `frontend/src/lib/kanbanPanelView.test.ts`
- Test: `frontend/src/lib/kanbanSessionLayout.test.ts`

**Step 1: 鍐欏け璐ユ祴璇曪紝瑕嗙洊绠ご鏄鹃殣涓庢柟鍚?*

鍦ㄥ凡鏈夋祴璇曞熀纭€涓婃柊澧炴柇瑷€锛岀‘淇濓細

- `board` 鍙樉绀鸿繘鍏?`sessionHub` 鐨勭澶?
- `sessionHub` 鍚屾椂鍏峰杩斿洖鍜屽墠杩?
- `usageDashboard` 鍙樉绀鸿繑鍥?

**Step 2: 杩愯娴嬭瘯锛岀‘璁ゅけ璐?*

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
```

Expected: FAIL锛屾彁绀烘柊鐘舵€佸皻鏈畬鍏ㄦ帴鍏ャ€?

**Step 3: 鍐欐渶灏忓疄鐜?*

鍦?`frontend/src/components/panels/DockviewKanbanPanel.tsx` 涓細

- 澧炲姞鍙充晶绠ご
- 鏍规嵁褰撳墠瑙嗗浘鐘舵€佹帶鍒剁澶存樉闅愪笌 aria-label
- 淇濊瘉鍘熸湁 Session Hub 涓庝細璇濆崱鐐瑰嚮閫昏緫涓嶅彉

鍦?`frontend/src/contexts/KanbanSessionContext.tsx` 涓細

- 鎻愪緵 `goToBoard / goToSessionHub / goToUsageDashboard`
- 淇濇寔 `openSessionFromList`銆乣replaceRightSession`銆乣promoteMonitorSession` 鐜版湁琛屼负涓嶅彉

**Step 4: 杩愯楠岃瘉锛岀‘璁ら€氳繃**

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
pnpm run check
cargo test --package vibex
```

Expected: PASS

**Step 5: 鎻愪氦妫€鏌ョ偣**

Run:

```bash
git add frontend/src/components/panels/DockviewKanbanPanel.tsx frontend/src/contexts/KanbanSessionContext.tsx frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
git commit -m "feat: wire kanban usage dashboard navigation"
```

### Task 7: 鏈€缁堝洖褰掍笌鏂囨。鏍￠獙

**Files:**
- Modify: `docs/plans/2026-03-22-kanban-usage-dashboard-design.md`
- Modify: `docs/plans/2026-03-22-kanban-usage-dashboard.md`

**Step 1: 杩愯瀹屾暣楠岃瘉**

Run:

```bash
pnpm run generate-types:check
pnpm run check
cargo test --workspace
```

Expected: PASS

**Step 2: 鎵嬪姩楠岃瘉**

鎵嬪姩妫€鏌ワ細

- Kanban 榛樿杩涘叆涓昏鍥?
- 宸︾澶磋繘鍏?Session Hub
- 鍙崇澶磋繘鍏?Usage Dashboard
- Usage Dashboard 鍙互姝ｇ‘灞曠ず鍥涗釜 tab
- 椤圭洰娌℃湁 usage 鏁版嵁鏃舵樉绀虹┖鎬?
- 鏌愪釜 provider 澶辫触鏃舵樉绀洪儴鍒嗘垚鍔熺姸鎬?

**Step 3: 鏇存柊璁″垝鏂囨。涓殑瀹為檯宸紓**

鑻ュ疄鐜拌繃绋嬫湁鍋忓樊锛屽洖鍐欏埌杩欎袱浠芥枃妗ｏ紝纭繚鏂囨。涓庝唬鐮佷竴鑷淬€?

**Step 4: 鍐嶆杩愯鍏抽敭楠岃瘉**

Run:

```bash
pnpm run check
cargo test --workspace
```

Expected: PASS

**Step 5: 鎻愪氦鏈€缁堟鏌ョ偣**

Run:

```bash
git add docs/plans/2026-03-22-kanban-usage-dashboard-design.md docs/plans/2026-03-22-kanban-usage-dashboard.md
git commit -m "docs: add kanban usage dashboard plan"
```
