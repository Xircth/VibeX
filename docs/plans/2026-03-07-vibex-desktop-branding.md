# VibeX Desktop Branding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 灏嗘闈㈢鍝佺墝鏇存柊涓?`VibeX`锛屼繚鐣?Tauri + frontend 鏋舵瀯锛屽苟绉婚櫎鐙珛 Web/PWA 鍝佺墝鍏ュ彛銆?

**Architecture:** 淇濇寔 `frontend/` 浣滀负妗岄潰绔唴宓?UI锛屼粎璋冩暣鐢ㄦ埛鍙鍝佺墝鏂囨銆佺粺涓€ Logo 缁勪欢銆佹浛鎹?Tauri bundle icon锛屽苟鍘婚櫎 `index.html` 涓嫭绔?Web/PWA 鍏ュ彛寮曠敤銆傛妧鏈爣璇嗕笉鏀癸紝閬垮厤鐮村潖鏋勫缓涓庡閮ㄩ泦鎴愩€?

**Tech Stack:** Tauri v2銆丷eact銆乀ypeScript銆乂ite銆丯ode test銆丆argo check

---

## Task 1: 鍐欏搧鐗屽洖褰掓祴璇?

**Files:**
- Create: `frontend/tests/branding-desktop-only.test.js`

**Step 1: Write the failing test**

娣诲姞浠ヤ笅鏂█锛?

- `frontend/src/components/Logo.tsx` 鍖呭惈 `VibeX`
- `frontend/src/pages/settings/SettingsLayout.tsx` 浣跨敤鍐呴儴鍝佺墝鍥?
- `frontend/index.html` 涓嶅啀鍖呭惈 `site.webmanifest` 涓?`favicon-vk`
- `src-tauri/tauri.conf.json` 鐨勫搧鐗屽€兼渶缁堝簲涓?`VibeX`

**Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: FAIL锛屽洜涓哄綋鍓嶆簮鐮佷粛鍖呭惈 `Vibe Kanban` / `favicon-vk` / 鏃ф爣棰樸€?

**Step 3: Do not commit**

鎸変粨搴?`AGENTS.md`锛屾湰娆¤烦杩?commit 姝ラ銆?

---

## Task 2: 鏇存柊鍓嶇鍝佺墝璧勬簮涓庡睍绀虹粍浠?

**Files:**
- Create: `frontend/src/assets/vibex.png`
- Modify: `frontend/src/components/Logo.tsx`
- Modify: `frontend/src/pages/settings/SettingsLayout.tsx`
- Modify: `frontend/src/components/layout/StatusBar.tsx`
- Modify: `frontend/src/components/welcome/WelcomePage.tsx`
- Modify: `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/DisclaimerDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/BetaWorkspacesDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/ReleaseNotesDialog.tsx`
- Modify: `frontend/src/contexts/ProjectContext.tsx`
- Modify: `frontend/src/components/dialogs/tasks/CreatePRDialog.tsx`

**Step 1: Copy internal logo asset**

灏?`C:/Users/Administrator/Downloads/VibeX.png` 澶嶅埗鍒?`frontend/src/assets/vibex.png`銆?

**Step 2: Implement minimal branding updates**

- `Logo.tsx` 鏀逛负鍥剧墖 + `VibeX`
- `SettingsLayout.tsx` 鍦ㄩ〉澶村睍绀哄唴閮ㄥ搧鐗屽浘
- 缁熶竴鍏抽敭鐢ㄦ埛鍙鏂囨涓?`VibeX`
- `ProjectContext.tsx` 椤甸潰鏍囬鏀逛负 `VibeX`
- `CreatePRDialog.tsx` 榛樿 PR 鏍囬鍚庣紑鏀逛负 `(VibeX)`

**Step 3: Run test to verify progress**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: 涓庡墠绔搧鐗岀浉鍏虫柇瑷€閫氳繃锛汿auri 閰嶇疆鐩稿叧鏂█鏆傚彲鑳戒粛澶辫触銆?

---

## Task 3: 鏇存柊妗岄潰绔簲鐢ㄥ悕涓庡浘鏍?

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/icons/*`

**Step 1: Update desktop visible name**

灏?`src-tauri/tauri.conf.json` 涓細

- `productName` 鏀逛负 `VibeX`
- `app.windows[0].title` 鏀逛负 `VibeX`

**Step 2: Generate icon set**

浠?`C:/Users/Administrator/Downloads/VibeX_background.png` 鐢熸垚 `src-tauri/icons/` 闇€瑕佺殑鏍囧噯鍥炬爣鏂囦欢銆?

**Step 3: Run test to verify it passes**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS銆?

---

## Task 4: 鍘婚櫎鐙珛 Web/PWA 鍏ュ彛寮曠敤

**Files:**
- Modify: `frontend/index.html`

**Step 1: Remove manifest and favicon references**

鍒犻櫎鎴栧仠鐢細

- `rel="icon"` 鐨?`favicon-vk-*`
- `rel="apple-touch-icon"`
- `rel="manifest"`锛堝瀛樺湪锛?

淇濈暀鍩虹 HTML 澹充笌椤甸潰鏍囬銆?

**Step 2: Verify via tests**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS銆?

---

## Task 5: 瀹屾暣楠岃瘉

**Files:**
- Verify only

**Step 1: Run targeted test**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS銆?

**Step 2: Run frontend type check**

Run: `pnpm run frontend:check`

Expected: exit 0銆?

**Step 3: Run backend check**

Run: `pnpm run backend:check`

Expected: exit 0銆?

**Step 4: Run final search**

Run: `rg -n --hidden --glob '!Vibe-kanban-originbase/**' --glob '!.git/**' 'Vibe Kanban Promax|VIBE-KANBAN-PROMAX|Vibe Kanban|vibe-kanban' frontend src-tauri`

Expected: 浠呭墿鎶€鏈爣璇嗘垨鏄庣‘淇濈暀椤癸紱鏃犻仐婕忕殑鐢ㄦ埛鍙鍝佺墝鏂囨銆?

**Step 5: Do not commit**

鎸変粨搴?`AGENTS.md`锛屾湰娆¤烦杩?commit 姝ラ銆?
