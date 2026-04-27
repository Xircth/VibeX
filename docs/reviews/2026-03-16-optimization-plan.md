# VibeX 椤圭洰浼樺寲鏂规

> 鍒跺畾鏃ユ湡: 2026-03-16 (绗簩杞?
> 鍩轰簬: 浠ｇ爜瀹℃煡鎶ュ憡銆佸墠绔鏌ユ姤鍛娿€佷緷璧栧垎鏋愭姤鍛娿€佹€ц兘涓庡畨鍏ㄥ垎鏋愭姤鍛?

---

## 浼樺寲璺嚎鍥?

### 闃舵涓€锛歅0 瀹夊叏淇锛?-2 灏忔椂锛?

| # | 浠诲姟 | 鏂囦欢 | 淇鏂瑰紡 |
|---|------|------|----------|
| S1 | 鏀剁揣 Tauri fs 鏉冮檺 | `src-tauri/capabilities/default.json` | 闄愬埗涓?`$HOME/.claude/**`銆乣$HOME/.vibex/**`銆乣$RESOURCE/**`銆佷粨搴撹矾寰?|
| S2 | file_tree 璺緞娌欑洅 | `src-tauri/src/commands/file_tree.rs` | 楠岃瘉璺緞蹇呴』浣嶄簬宸叉敞鍐屼粨搴?宸ヤ綔鍖轰笅锛涙嫆缁?`..` 缁勪欢 |
| S3 | PowerShell 鍛戒护娉ㄥ叆淇 | `crates/utils/src/browser.rs:8-9` | 瀵瑰崟寮曞彿杞箟鎴栨敼鐢?`-Uri` 鍙傛暟鍖?|
| S4 | PowerShell 鍛戒护娉ㄥ叆淇 | `crates/services/src/services/notification.rs:90-91` | 鍙傛暟鍖栦紶閫掓枃浠惰矾寰?|
| S5 | osascript 鍛戒护娉ㄥ叆淇 | `crates/services/src/services/notification.rs:111-120` | 鏀圭敤 `notify-rust` crate |
| S6 | aimax filename 楠岃瘉 | `src-tauri/src/commands/skills.rs:206-218` | 娣诲姞鐧藉悕鍗曟牎楠?|

---

### 闃舵浜岋細闆舵垚鏈竻鐞嗭紙30 鍒嗛挓锛?

鏃犲姛鑳藉彉鏇达紝绾竻鐞嗘搷浣溿€?

| # | 浠诲姟 | 鎿嶄綔 |
|---|------|------|
| C1 | 绉婚櫎 `@ibm/plex` devDep | `pnpm remove @ibm/plex` -- 鑺傜渷 ~30MB |
| C2 | 绉婚櫎 `@tailwindcss/container-queries` | `pnpm remove` + 娓呯悊 Tailwind 閰嶇疆 |
| C3 | 淇 `@rjsf/*` 鍒嗙被 | devDep -> dependencies |
| C4 | 绉诲姩 tailwind 鎻掍欢鍒?devDep | `tailwind-scrollbar`銆乣tailwindcss-animate` |
| C5 | 娓呯悊 New Design 娈嬬暀 | 鍒犻櫎 `tailwind.new.config.js`锛涙洿鏂?`components.json`锛涙竻鐞嗘枃妗ｅ紩鐢?|
| C6 | 閲嶅懡鍚?`useConversationHistoryOld.ts` | -> `useConversationHistory.ts` |

---

### 闃舵涓夛細涓婚閫傞厤 Bug 淇锛?-2 灏忔椂锛?

#### 3.1 conversation.css 浜壊妯″紡 Bug

```css
/* 淇鍓?(绗?98琛? */
.conv-assistant-msg .ProseMirror pre {
  background: #1e1e2e !important;
}

/* 淇鍚?-- 浣跨敤 CSS 鍙橀噺 */
.conv-assistant-msg .ProseMirror pre {
  background: var(--conv-code-bg) !important;
}
```

#### 3.2 file-tree.css 娣诲姞鏆楄壊/浜壊鏀寔

涓虹害 15 涓?token 绫诲瀷棰滆壊鍜?Git 鐘舵€侀鑹叉坊鍔?`.dark` 鍙樹綋锛?

```css
/* 浜壊妯″紡锛堥粯璁わ級 */
.file-tree-token-keyword { color: #cf222e; }
/* 鏆楄壊妯″紡 */
.dark .file-tree-token-keyword { color: #ff7b72; }
```

#### 3.3 ProjectTasks.tsx 纭紪鐮侀鑹?

```tsx
/* 淇鍓?*/
style={{ backgroundColor: '#FCFCFC' }}
/* 淇鍚?*/
className="bg-background"
```

---

### 闃舵鍥涳細浠ｇ爜璐ㄩ噺浼樺寲锛?-4 灏忔椂锛?

#### 4.1 绌?catch 鍧楁竻鐞嗭紙101 澶勶級

鎸変紭鍏堢骇鍒嗘壒澶勭悊锛?
1. 鍏抽敭璺緞锛圙it 鎿嶄綔銆佹枃浠舵搷浣滐級-- 娣诲姞鐢ㄦ埛鍙鐨?toast 閿欒鎻愮ず
2. 闃插尽鎬х紪绋嬶紙dockview 鎿嶄綔锛?- 娣诲姞 `// expected: dockview may throw during reconstruction` 娉ㄩ噴
3. 鍏朵綑 -- 鑷冲皯娣诲姞 `console.error` 鏃ュ織

#### 4.2 Rust unwrap() 鏇挎崲锛?+ 澶勶級

鏇挎崲涓?`unwrap_or_else`/`ok_or`/`?` 鎿嶄綔绗︼紝杩斿洖 `anyhow::Result`銆?

#### 4.3 鎻愬彇榄旀硶鏁板瓧

**鏂囦欢**: `IDELayout.tsx`

```typescript
const LAYOUT = {
  LEFT_PANEL_DEFAULT_WIDTH: 220,
  LEFT_PANEL_MIN_WIDTH: 200,
  LAYOUT_RETRY_COUNT: 15,
  LAYOUT_SETTLE_DELAY_MS: 100,
} as const;
```

#### 4.4 淇 pushError 璇箟

**鏂囦欢**: `useGitCommit.ts` -- 閲嶅懡鍚嶄负 `operationError`锛屾垨涓?pull/fetch 鎻愪緵鐙珛閿欒鐘舵€併€?

#### 4.5 鍚堝苟 usePush + useForcePush

鍚堝苟涓?`usePushOperation(force: boolean)` hook銆?

---

### 闃舵浜旓細鎬ц兘浼樺寲锛?-6 灏忔椂锛?

#### 5.1 [P0] 鏂囦欢鏍戣櫄鎷熸粴鍔?

**鏂囦欢**: `FileTreePanel.tsx`

浣跨敤 react-virtuoso 鎵佸钩鍖栦负铏氭嫙婊氬姩鍒楄〃锛岄€氳繃缂╄繘灞傜骇妯℃嫙鏍戠粨鏋勶紙VS Code 妯″紡锛夈€?

#### 5.2 [P0] 瀵硅瘽鍘嗗彶铏氭嫙婊氬姩

**鏂囦欢**: `DisplayConversationEntry.tsx`

浣跨敤 react-virtuoso 鐨勫姩鎬侀珮搴﹁櫄鎷熷寲銆?

#### 5.3 [P1] scroll 浜嬩欢鑺傛祦

**鏂囦欢**: `GitDiffViewer.tsx:83-103`

鏇挎崲涓?`IntersectionObserver`锛堝弬鑰?`DockviewDiffsReviewPanel.tsx:184` 鐨勫疄鐜帮級銆?

#### 5.4 [P1] N+1 鏌ヨ淇

- `agent_setting.rs:92` -- 浣跨敤浜嬪姟鎵瑰鐞?reorder
- `image.rs:186` -- 浣跨敤浜嬪姟鍖呰９鎵归噺 INSERT

#### 5.5 [P2] 寮傛骞惰鍖?

瀵圭嫭绔嬬殑鏁版嵁搴撴煡璇娇鐢?`tokio::join!` 骞惰鎵ц锛岃€岄潪涓茶 await銆?

#### 5.6 [P2] localStorage 搴忓垪鍖栦紭鍖?

灏嗛槻鎶栧欢鏃朵粠 100ms 澧炲姞鍒?300-500ms锛屾垨浣跨敤 `requestIdleCallback`銆?

#### 5.7 鎻愬彇 useTemporaryFlag hook

缁熶竴 10+ 澶?`setTimeout(() => setXxxSuccess(false), 2000)` 妯″紡銆?

---

### 闃舵鍏細渚濊禆缂╁噺锛?-3 灏忔椂锛?

#### 6.1 缁熶竴鍥炬爣搴?

绉婚櫎 `@phosphor-icons/react`锛堜慨鏀?3 鏂囦欢锛夊拰 `developer-icons`锛堜慨鏀?1 鏂囦欢锛夛紝缁熶竴鍒?`lucide-react`銆傝妭鐪?**~500KB+**銆?

#### 6.2 绉婚櫎 CodeMirror 鍏ㄥ

绉婚櫎 `@uiw/react-codemirror` + 4 涓?`@codemirror/*` 鍖咃紝`json-editor.tsx` 鏀圭敤 Monaco銆傝妭鐪?**~300KB**銆?

#### 6.3 Rust workspace 渚濊禆缁熶竴

鍦ㄦ牴 `Cargo.toml` 鐨?`[workspace.dependencies]` 涓坊鍔狅細

```toml
[workspace.dependencies]
sqlx = { version = "0.8", default-features = false }
dirs = "5"
command-group = { version = "5.0", features = ["with-tokio"] }
strum = "0.27.2"
strum_macros = "0.27.2"
json-patch = "2.0"
tempfile = "3"
regex = "1"
tokio-util = "0.7"
tokio-stream = "0.1"
```

鍚?crate 鏀逛负 `sqlx.workspace = true`锛屾寜闇€杩藉姞 features銆?

#### 6.4 缁熶竴鐩綍璺緞搴?

璇勪及 `dirs` vs `directories` vs `xdg`锛岀粺涓€涓轰竴涓€?

---

### 闃舵涓冿細澶ф枃浠舵媶鍒嗭紙闀挎湡锛屾寜闇€鎵ц锛?

#### 7.1 Rust 澶ф枃浠?

| 鏂囦欢 | 琛屾暟 | 鎷嗗垎鏂规 |
|------|------|----------|
| `git/src/lib.rs` | 2776 | `branch.rs` + `diff.rs` + `worktree.rs` + `rebase.rs` + `remote.rs` + `log.rs` |
| `executors/claude.rs` | 2723 | `normalize.rs` + `protocol.rs` + `tool_handler.rs`锛涙祴璇曠Щ鑷?`tests/` |
| `local-deployment/container.rs` | 1467 | `container_lifecycle.rs` + `container_config.rs` |
| `executors/opencode/sdk.rs` | 1463 | 鎷嗗垎 SDK 杩炴帴灞傚拰娑堟伅澶勭悊灞?|
| `services/container.rs` | 1426 | 鎷嗗垎鏈嶅姟娉ㄥ唽涓庢湇鍔＄紪鎺?|
| `git/src/cli.rs` | 1263 | 鎸?Git 瀛愬懡浠ゆ媶鍒?|

#### 7.2 鍓嶇澶ф枃浠?

| 鏂囦欢 | 琛屾暟 | 鎷嗗垎鏂规 |
|------|------|----------|
| `api.ts` | 1367 | `api/attempts.ts` + `api/repos.ts` + `api/git.ts` + `api/config.ts` + `api/sessions.ts` |
| `FileTreePanel.tsx` | 1359 | `FileTreeItem.tsx` + `FileTreeContextMenu.tsx` + `useFileTree.ts` + `fileTreeUtils.ts` |
| `DisplayConversationEntry.tsx` | 1205 | `entries/AssistantMessage.tsx` + `ToolCallCard.tsx` + `ThinkingBlock.tsx` |
| `IDELayout.tsx` | 971 | `dockviewLayoutUtils.ts` + `dockviewEventHandlers.ts` + `dockview-ayu.css`(鎻愬彇鍐呰仈) |

#### 7.3 CSS 澶ф枃浠?

| 鏂囦欢 | 琛屾暟 | 鎷嗗垎鏂规 |
|------|------|----------|
| `file-tree.css` | 1094 | `file-tree-base.css` + `file-tree-syntax.css` + `file-tree-git.css` |
| `conversation.css` | 1024 | `conv-base.css` + `conv-messages.css` + `conv-tools.css` + `conv-markdown.css` + `conv-syntax.css` |
| `diff-style-overrides.css` | 989 | `diff-layout.css` + `diff-widgets.css` + `diff-syntax-light.css` + `diff-syntax-dark.css` |

---

### 闃舵鍏細涓婚绯荤粺缁熶竴锛堥暱鏈燂級

1. 纭骞跺垹闄?New Design 绯荤粺娈嬬暀
2. 灏?`conversation.css` 鐨勯鑹插彉閲忚縼绉诲埌 Legacy Design 浣撶郴
3. 灏?`file-tree.css` 娣诲姞瀹屾暣鐨勬殫鑹?浜壊鏀寔
4. 缁熶竴鏆楄壊鍒囨崲鏂瑰紡涓?`.dark` class锛堟秷闄?`data-theme='dark'`锛?
5. 灏嗘墍鏈夌粍浠剁‖缂栫爜棰滆壊杩佺Щ涓鸿涔夊寲 CSS 鍙橀噺
6. 娑堝噺 `conversation.css` 涓?41 澶?`!important`

---

## 浼樺厛绾ф€昏

| 闃舵 | 浼樺厛绾?| 棰勪及鏃堕棿 | 椋庨櫓 | 鏍稿績鏀剁泭 |
|------|--------|----------|------|----------|
| 涓€ | P0 | 1-2h | 浣?| 淇 6 涓畨鍏ㄦ紡娲?|
| 浜?| P0 | 30min | 鏋佷綆 | 娓呯悊鍐椾綑锛岃妭鐪?30MB |
| 涓?| P1 | 1-2h | 浣?| 淇浜壊妯″紡瑙嗚 bug |
| 鍥?| P1 | 3-4h | 浣?| 淇 101 澶勭┖ catch + 7 澶?unwrap |
| 浜?| P1 | 4-6h | 涓?| 铏氭嫙婊氬姩 + N+1 淇 |
| 鍏?| P2 | 2-3h | 浣?| 鍑忓皯 ~1MB bundle + Rust 渚濊禆缁熶竴 |
| 涓?| P3 | 鎸夐渶 | 涓?| 鏂囦欢缁勭粐浼樺寲 |
| 鍏?| P3 | 鎸夐渶 | 涓?| 涓婚涓€鑷存€?|
