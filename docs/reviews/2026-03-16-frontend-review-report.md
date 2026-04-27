# VibeX 鍓嶇瀹℃煡鎶ュ憡

> 瀹℃煡鏃ユ湡: 2026-03-16 (绗簩杞?
> 瀹℃煡鑼冨洿: `frontend/src/` 鍏ㄩ儴鍓嶇浠ｇ爜
> 鎬讳綋璇勭骇: **璀﹀憡** -- 瀛樺湪涓婚閫傞厤瑙嗚 bug 鍜屽涓淮鎶ら棶棰?

---

## 涓€銆丆SS 鏂囦欢瀵煎叆鐘舵€?

### 鎵€鏈夌幇瀛?CSS 鏂囦欢鍧囧凡姝ｇ‘瀵煎叆

| CSS 鏂囦欢 | 瀵煎叆鏂瑰紡 | 瀵煎叆浣嶇疆 |
|----------|----------|----------|
| `conversation.css` | `import` | `DisplayConversationEntry.tsx` |
| `dockview-ayu.css` | `?raw` 鍐呰仈娉ㄥ叆 | `IDELayout.tsx` |
| `diff-style-overrides.css` | `import` | `DiffCard.tsx`銆乣FileContentView.tsx`銆乣FileChangeRenderer.tsx`銆乣EditDiffRenderer.tsx` (4 澶勯噸澶嶅鍏? |
| `edit-diff-overrides.css` | `import` | `FileContentView.tsx`銆乣EditDiffRenderer.tsx` |
| `file-tree.css` | `import` | `FileTreePanel.tsx` |
| `fonts.css` | `@import` | `legacy/index.css` |
| `legacy/index.css` | `import` | `LegacyDesignScope.tsx` |

### [楂榏 New Design CSS 宸插垹闄や絾閰嶇疆鏈竻鐞?

**闂**: `styles/new/index.css` 鏂囦欢宸蹭笉瀛樺湪锛屼絾浠ヤ笅浣嶇疆浠嶅紩鐢細
- `frontend/components.json:8` -- `"css": "src/styles/new/index.css"`
- `frontend/CLAUDE.md` 鏂囨。澶氬鎻愬強
- `frontend/tests/settings-page.test.js:68` 灏濊瘯璇诲彇

`tailwind.new.config.js` 浠嶅瓨鍦ㄤ絾鏃犲疄闄呬綔鐢ㄣ€俙NewDesignScope` 缁勪欢浠庢湭瀹氫箟鎴栦娇鐢ㄣ€?

**淇**: 鍒犻櫎 `tailwind.new.config.js`锛涙洿鏂?`components.json` 鎸囧悜 `legacy/index.css`锛涙竻鐞嗘枃妗ｅ紩鐢ㄣ€?

### [涓璢 diff-style-overrides.css 琚?4 澶勯噸澶嶅鍏?

鍚屼竴 CSS 鏂囦欢鍦?4 涓粍浠朵腑閲嶅 `import`銆傝櫧鐒?Vite 浼氬幓閲嶏紝浣嗗缓璁彁鍗囧埌鏇撮珮灞傜骇缁熶竴瀵煎叆銆?

---

## 浜屻€佹湭浣跨敤鐨勭粍浠?

### 宸插垹闄ゆ枃浠跺紩鐢ㄦ竻鐞嗙姸鎬?

鎵€鏈?git status 鏍囪涓?`D` 鐨勬枃浠讹紙鍏?15 涓級鐨勫紩鐢ㄥ潎宸?*姝ｇ‘娓呯悊**锛屾棤娈嬬暀 import銆傚叿浣撳寘鎷細
- `DevBanner.tsx`, `ExecutorConfigForm.tsx`, `NewDesignLayout.tsx`
- `ExecutorProfileSelector.tsx`
- `ClaudeCodeForm.tsx`, `CodexForm.tsx`, `OpenCodeForm.tsx`, `agent-forms/index.ts`
- `GeneralSettings.tsx`, `ProjectSettings.tsx`, `ReposSettings.tsx`
- `CreateConfigurationDialog.tsx`, `DeleteConfigurationDialog.tsx`
- `useGitHubStars.ts`, `TasksLayout.tsx`

---

## 涓夈€佹殫鑹?浜壊涓婚閫傞厤闂

### 3.1 [楂榏 conversation.css 浜壊妯″紡浠ｇ爜鍧椾娇鐢ㄦ殫鑹茶儗鏅?

**鏂囦欢**: `frontend/src/styles/conversation.css:498`

```css
.conv-assistant-msg .ProseMirror pre {
  background: #1e1e2e !important;  /* Catppuccin 鏆楄壊鑳屾櫙 */
}
```

姝ら€夋嫨鍣?*涓嶅湪 `.dark` 浣滅敤鍩熷唴**锛屾剰鍛崇潃浜壊妯″紡涓嬩唬鐮佸潡涔熸樉绀烘繁鑹茶儗鏅?`#1e1e2e`锛屼笌鏁翠綋浜壊涓婚涓ラ噸涓嶅崗璋冦€?

**鍙﹀**绗?520 琛?`color: #c9d1d9 !important` 涔熷湪闈?`.dark` 閫夋嫨鍣ㄤ腑浣跨敤浜嗘殫鑹蹭富棰橀鑹层€?

### 3.2 [楂榏 file-tree.css 瀹屽叏娌℃湁鏆楄壊/浜壊涓婚鍖哄垎

**鏂囦欢**: `frontend/src/styles/file-tree.css` (1094 琛?

鏁翠釜鏂囦欢涓?`.dark` 閫夋嫨鍣ㄥ嚭鐜?**0 娆?*銆傛墍鏈夎娉曢珮浜鑹诧紙970-1049 琛岋紝绾?15 涓?token 绫诲瀷锛夊潎涓虹‖缂栫爜鏆楄壊涓婚鍊硷紙`#ff7b72`銆乣#7ee787`銆乣#d2a8ff`锛夛紝鍦ㄤ寒鑹茶儗鏅笂瀵规瘮搴︿笉瓒炽€?

Git 鐘舵€侀鑹诧紙1014-1049 琛岋級鍚屾牱纭紪鐮侊細
- `git-a`(鏂板): `#89d185`
- `git-m`(淇敼): `#6bb3f0`
- `git-d`(鍒犻櫎): `#ff6b6b`

### 3.3 [涓璢 conversation.css 纭紪鐮侀鑹叉湭璧?CSS 鍙橀噺

铏界劧鏂囦欢椤堕儴锛?-54 琛岋級瀹氫箟浜?`--conv-*` CSS 鍙橀噺骞跺尯鍒嗕簡 `:root`(浜壊) 鍜?`.dark`(鏆楄壊)锛屼絾鍚庡崐閮ㄥ垎澶ч噺鐩存帴浣跨敤纭紪鐮?HEX 鍊硷細

- 288-289: `.dark .conv-terminal-output` 浣跨敤 `#0f1117`/`#7ee787`锛屼絾浜壊缂哄搴旀牱寮?
- 766-852: Prism token 棰滆壊绾?40 澶勭‖缂栫爜
- 1007-1024: 浠ｇ爜鍧楄儗鏅?`#f6f8fa`(浜?/`#0d1117`(鏆? 鐩存帴纭紪鐮?

### 3.4 [涓璢 diff-style-overrides.css 閮ㄥ垎浜壊鏍峰紡缂烘殫鑹查€傞厤

璇ユ枃浠舵暣浣撳仛寰楄緝濂斤紙绾?51 澶?`data-theme='dark'`锛夛紝浣嗕互涓嬬己澶憋細
- 477: tooltip 鑳屾櫙 `#555555` 涓ょ涓婚鍚岃壊
- 546: `background: #ffffff` 浠呬寒鑹?
- 641-647: `.hljs-addition` 鑳屾櫙 `#f0fff4` 鍜?`.hljs-deletion` 鑳屾櫙 `#ffeef0` 浠呬寒鑹?

### 3.5 [涓璢 缁勪欢纭紪鐮侀鑹?

| 鏂囦欢 | 琛屽彿 | 棰滆壊 | 闂 |
|------|------|------|------|
| `ProjectTasks.tsx` | 153 | `#FCFCFC` | 杩戠櫧鑹茶儗鏅紝鏆楄壊妯″紡涓嬩负鐧借壊鍧?|
| `CommitGraph.tsx` | 15-18 | `#3B82F6`/`#9CA3AF`/`#F59E0B` | SVG 棰滆壊鏃犱富棰橀€傞厤 |
| `WindowControls.tsx` | 89 | `#e81123` | Windows 绯荤粺鑹诧紝鍙帴鍙?|

### 3.6 鏆楄壊妯″紡瀹炵幇鏂瑰紡涓嶇粺涓€

| 绯荤粺 | 鏆楄壊鍒囨崲鏂瑰紡 |
|------|-------------|
| Legacy Design | `.dark` CSS class |
| Conversation CSS | `.dark` CSS class |
| Diff Overrides | `data-theme='dark'` 灞炴€?|
| File Tree | **鏃犳殫鑹叉敮鎸?* |

---

## 鍥涖€佸涓婚绯荤粺骞跺瓨

褰撳墠瀛樺湪 **涓夊鐙珛鏍峰紡绯荤粺**锛?

| 绯荤粺 | 鍏ュ彛鏂囦欢 | 鐘舵€?|
|------|----------|------|
| Legacy Design | `styles/legacy/index.css` | **褰撳墠鐢熸晥** -- 鎵€鏈夎矾鐢卞寘瑁瑰湪 `LegacyDesignScope` |
| New Design | `styles/new/index.css` | **宸插垹闄?* -- 閰嶇疆鏈竻鐞?|
| Conversation CSS | `styles/conversation.css` | **鐙珛绯荤粺** -- 鍙橀噺涓?Legacy 浜掍笉鍏宠仈 |

鍙︽湁鐙珛鐨?`diff-style-overrides.css`銆乣file-tree.css`銆乣dockview-ayu.css`銆?

**寤鸿**: 缁熶竴涓轰竴濂椾富棰樺彉閲忕郴缁燂紝娑堥櫎 New Design 娈嬬暀銆?

---

## 浜斻€佽秴澶ф牱寮忔枃浠?

| 鏂囦欢 | 琛屾暟 | 鎷嗗垎寤鸿 |
|------|------|----------|
| `file-tree.css` | **1094** | `file-tree-base.css` + `file-tree-syntax.css` + `file-tree-git.css` |
| `conversation.css` | **1024** | `conv-base.css` + `conv-messages.css` + `conv-tools.css` + `conv-markdown.css` + `conv-syntax.css` |
| `diff-style-overrides.css` | **989** | `diff-layout.css` + `diff-widgets.css` + `diff-syntax-light.css` + `diff-syntax-dark.css` |

---

## 鍏€?important 婊ョ敤

- `conversation.css`: **41 澶?* `!important` -- 浠ｇ爜鍧楀尯鍩熻繛缁?8 涓?
- `diff-style-overrides.css`: 6 澶?-- 鐩稿鍏嬪埗

---

## 涓冦€佸懡鍚嶄笌缁勭粐闂

### useConversationHistoryOld 鍛藉悕璇

**鏂囦欢**: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts` (751 琛?

"Old" 鍚庣紑鏆楃ず杩囨浮浠ｇ爜锛屼絾 `index.ts` 鐩存帴 re-export 涓?`useConversationHistory`锛屾槸鍞竴瀹炵幇銆?

**寤鸿**: 閲嶅懡鍚嶄负 `useConversationHistory.ts`銆?

---

## 鍏€佹€荤粨

| 鍒嗙被 | 鏁伴噺 |
|------|------|
| 楂樹紭鍏堢骇 | 4 椤癸紙浠ｇ爜鍧楁殫鑹茶儗鏅?bug銆乫ile-tree 鏃犱富棰樻敮鎸併€丯ew Design 閰嶇疆娈嬬暀銆? 涓?CSS 瓒呭ぇ鏂囦欢锛?|
| 涓紭鍏堢骇 | 7 椤癸紙纭紪鐮侀鑹层€乨iff 涓婚缂哄け銆?important 婊ョ敤銆佷富棰樼郴缁熶笉缁熶竴銆佸懡鍚嶈瀵肩瓑锛?|
| 浣庝紭鍏堢骇 | 2 椤癸紙CSS 閲嶅瀵煎叆銆乨ockview ?raw 娉ㄥ叆锛?|
