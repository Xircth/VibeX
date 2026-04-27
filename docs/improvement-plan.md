# VibeX 椤圭洰鏀硅繘瑙勫垝鏂囨。

> 鍩轰簬 MossX 鍙傝€冮」鐩殑娣卞害瀵规瘮鍒嗘瀽锛屽埗瀹?VibeX 鍔熻兘瀵归綈涓?UI 浼樺寲璺嚎鍥俱€?
> 鎸?Phase 鍒掑垎锛屽悇 Phase 鍐呴儴鎸変紭鍏堢骇鎺掑垪銆?

---

## Phase 1 鈥?鍩虹浣撻獙鎻愬崌

> 鐩爣锛氳В鍐冲綋鍓嶆渶褰卞搷鐢ㄦ埛浣撻獙鐨勭煭鏉匡紝蹇€熻鏁堛€?

### 1.1 鍏ㄥ眬鎼滅储绯荤粺 (Command Palette)

**鐜扮姸**锛歏ibeUltra 浠呮湁鍩虹 SearchBar锛岀己灏戠粺涓€鎼滅储鍏ュ彛銆?
**MossX 鍙傝€?*锛歚src/features/search/` 鈥?8 绉?Provider銆丅M25 鎺掑簭銆丆md+K 瑙﹀彂銆?

**瀹炵幇瑕佺偣**锛?
- 蹇嵎閿?`Cmd+K` / `Ctrl+K` 瑙﹀彂鍏ㄥ眬鎼滅储闈㈡澘
- Provider 鏋舵瀯锛堝彲鎵╁睍锛夛細
  - `commandsProvider` 鈥?搴旂敤鍐呭懡浠わ紙鍒囨崲闈㈡澘銆佹墦寮€璁剧疆绛夛級
  - `filesProvider` 鈥?宸ヤ綔鍖烘枃浠舵悳绱?
  - `kanbanProvider` 鈥?鐪嬫澘浠诲姟鎼滅储
  - `threadsProvider` 鈥?瀵硅瘽绾跨▼/Attempt 鎼滅储
  - `historyProvider` 鈥?鏈€杩戞搷浣滃巻鍙?
- 鎺掑簭绠楁硶锛氬弬鑰?`search/ranking/score.ts`锛圔M25 + 鏃惰繎搴﹀姞鏉冿級
- UI锛氬眳涓脊鍑烘ā鎬佹锛屽疄鏃惰繃婊わ紝鍒嗙被灞曠ず缁撴灉

**鍙傝€冩枃浠?*锛?
```
mossx/src/features/search/
鈹溾攢鈹€ hooks/useUnifiedSearch.ts
鈹溾攢鈹€ providers/*.ts
鈹溾攢鈹€ ranking/score.ts
鈹斺攢鈹€ components/SearchPalette.tsx
```

---

### 1.2 杈撳叆澧炲己濂椾欢

**鐜扮姸**锛歍askFollowUpSection 鍔熻兘宸茶緝涓板瘜锛圖iff 缁熻銆乀oken 浣跨敤鐜囥€乄YSIWYG锛夛紝浣嗙己灏戣緭鍏ュ巻鍙插拰蹇嵎鎿嶄綔銆?

#### 1.2.1 杈撳叆鍘嗗彶 (Input History)

- 涓?涓嬫柟鍚戦敭缈婚槄鍘嗗彶娑堟伅
- 鎸佷箙鍖栧瓨鍌ㄥ埌 localStorage
- 鍙傝€冿細`mossx/src/features/composer/hooks/useInputHistoryStore.ts`

#### 1.2.2 @鏂囦欢寮曠敤

- 杈撳叆 `@` 瑙﹀彂鏂囦欢閫夋嫨寮瑰嚭妗?
- 閫変腑鏂囦欢鑷姩娉ㄥ叆涓轰笂涓嬫枃
- 鍦?WYSIWYG 缂栬緫鍣ㄤ腑浠ユ爣绛惧舰寮忓睍绀?
- 鍙傝€冿細`mossx/src/features/composer/components/ChatInputBox/ContextBar.tsx`

#### 1.2.3 鎻愮ず璇嶅寮哄櫒 (Prompt Enhancer)

- 鎻愪緵棰勮鎻愮ず璇嶆ā鏉匡紙濡?浠ｇ爜瀹℃煡"銆?閲嶆瀯寤鸿"銆?娴嬭瘯鐢熸垚"锛?
- 涓€閿彃鍏ュ埌杈撳叆妗?
- 鍙傝€冿細`mossx/src/features/composer/components/ChatInputBox/PromptEnhancerDialog.tsx`

---

### 1.3 CSS 涓婚绯荤粺缁熶竴

**鐜扮姸**锛歏ibeUltra 瀛樺湪涓ゅ鍓茶鐨勮璁＄郴缁燂紙legacy + new锛夛紝CSS 鍙橀噺鍛藉悕涓嶇粺涓€銆?
**MossX 鍙傝€?*锛氱粺涓€鐨?150+ CSS 鍙橀噺浣撶郴锛屾竻鏅扮殑璇箟鍖栧懡鍚嶃€?

**瀹炵幇瑕佺偣**锛?
- 缁熶竴涓轰竴濂?CSS 鍙橀噺浣撶郴锛屾秷闄?legacy/new 鍙岃建鍒?
- 閲囩敤璇箟鍖栧懡鍚嶏紙鍙傝€?MossX 鐨勫懡鍚嶈鑼冿級锛?

```css
/* 鏂囨湰灞傜骇 */
--text-primary      /* 榛樿鏂囨湰 */
--text-strong       /* 寮鸿皟鏂囨湰 */
--text-muted        /* 娆¤鏂囨湰 */
--text-faint        /* 鏈€娣℃枃鏈?*/

/* 琛ㄩ潰鑹?*/
--surface-sidebar   /* 渚ф爮鑳屾櫙 */
--surface-panel     /* 闈㈡澘鑳屾櫙 */
--surface-card      /* 鍗＄墖鑳屾櫙 */
--surface-hover     /* 鎮仠鎬?*/
--surface-active    /* 婵€娲绘€?*/
--surface-popover   /* 寮瑰嚭灞?*/

/* 杈规 */
--border-subtle     /* 鏈€娣¤竟妗?*/
--border-muted      /* 甯歌杈规 */
--border-strong     /* 寮鸿竟妗?*/

/* 鍝佺墝鑹?*/
--accent-primary    /* 涓昏壊璋?*/
--destructive       /* 鍗遍櫓鎿嶄綔 */
--success           /* 鎴愬姛鐘舵€?*/
--warning           /* 璀﹀憡鐘舵€?*/
```

- 鍚堝苟涓や釜 Tailwind 閰嶇疆涓轰竴涓?
- 鎵€鏈夌粍浠惰縼绉诲埌缁熶竴鍙橀噺

---

### 1.4 婊氬姩鏉′紭鍖?

**鐜扮姸**锛氫娇鐢ㄩ粯璁ゆ祻瑙堝櫒婊氬姩鏉★紝涓?IDE 椋庢牸涓嶅尮閰嶃€?
**MossX 鍙傝€?*锛氳嚜瀹氫箟缁嗘粴鍔ㄦ潯锛屾偓鍋滄椂骞虫粦鏄剧幇銆?

**瀹炵幇瑕佺偣**锛?
```css
/* 榛樿闅愯棌锛屾偓鍋滄椂鏄剧幇 */
*::-webkit-scrollbar { width: 8px; }
*::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 4px;
  background-color: var(--scrollbar-thumb);
}
/* Firefox */
scrollbar-width: thin;
scrollbar-color: transparent transparent;
```

---

## Phase 2 鈥?鏍稿績鍔熻兘瀵归綈

> 鐩爣锛氳ˉ榻?MossX 宸叉湁浣?VibeX 缂哄け鐨勬牳蹇冨姛鑳姐€?

### 2.1 椤圭洰璁板繂绯荤粺 (Project Memory)

**鐜扮姸**锛歏ibeUltra 瀹屽叏娌℃湁姝ゅ姛鑳姐€?
**MossX 鍙傝€?*锛歚src/features/project-memory/` 鈥?8 绉嶈蹇嗙被鍨嬨€佽嚜鍔ㄥ垎绫汇€佷笂涓嬫枃娉ㄥ叆銆?

**瀹炵幇瑕佺偣**锛?

#### 鍚庣 (Rust)
- 鏂板缓 `crates/project-memory/` crate
- 鏁版嵁妯″瀷锛?
  ```rust
  struct ProjectMemory {
      id: Uuid,
      project_id: Uuid,
      kind: MemoryKind,       // Architecture, Pattern, Security, Bug, Config 绛?
      content: String,
      source_thread_id: Option<Uuid>,
      created_at: DateTime,
      updated_at: DateTime,
  }
  ```
- SQLite 瀛樺偍锛屾敮鎸佸叏鏂囨悳绱?
- Tauri Command锛歚create_memory`銆乣list_memories`銆乣delete_memory`銆乣search_memories`

#### 鍓嶇
- 鏂板缓 `frontend/src/features/project-memory/`锛堥噰鐢?features 妯″紡锛?
- 缁勪欢锛?
  - `ProjectMemoryPanel` 鈥?璁板繂鍒楄〃/缂栬緫闈㈡澘锛屾敞鍐屼负 dockview 闈㈡澘
  - `MemoryBadge` 鈥?璁板繂绫诲瀷鏍囩
- Hooks锛?
  - `useProjectMemory()` 鈥?CRUD 鎿嶄綔
  - `useMemoryInjection()` 鈥?AI 瀵硅瘽鍓嶈嚜鍔ㄦ敞鍏ョ浉鍏宠蹇?
- 璁板繂鍒嗙被鍣細鍙傝€?`mossx/src/features/project-memory/utils/memoryKindClassifier.ts`

---

### 2.2 鍥介檯鍖?(i18n)

**鐜扮姸**锛歏ibeUltra 瀹屽叏娌℃湁 i18n 鏀寔銆?
**MossX 鍙傝€?*锛歚src/i18n/` 鈥?react-i18next锛屼腑鑻卞弻璇€?

**瀹炵幇瑕佺偣**锛?
- 瀹夎 `react-i18next` + `i18next`
- 鍒涘缓 `frontend/src/i18n/`锛?
  ```
  i18n/
  鈹溾攢鈹€ index.ts          鈫?i18next 鍒濆鍖?
  鈹斺攢鈹€ locales/
      鈹溾攢鈹€ en.ts         鈫?鑻辨枃
      鈹斺攢鈹€ zh.ts         鈫?涓枃
  ```
- 缈昏瘧 key 鎸夊姛鑳藉煙缁勭粐锛?
  ```typescript
  {
    toolbar: { newTask: "鏂板缓浠诲姟", settings: "璁剧疆" },
    kanban: { todo: "寰呭姙", inProgress: "杩涜涓?, done: "瀹屾垚" },
    composer: { placeholder: "杈撳叆娑堟伅...", send: "鍙戦€? },
    settings: { general: "甯歌", theme: "涓婚" }
  }
  ```
- 璁剧疆椤甸潰娣诲姞璇█鍒囨崲鍣?
- 浼樺厛缈昏瘧楂橀鐣岄潰鏂囨湰锛岄€愭瑕嗙洊

---

### 2.3 鑷姩鏇存柊绯荤粺

**鐜扮姸**锛歏ibeUltra 鏈疄鐜拌嚜鍔ㄦ洿鏂般€?
**MossX 鍙傝€?*锛歚src/features/update/` 鈥?tauri-plugin-updater銆?

**瀹炵幇瑕佺偣**锛?
- 闆嗘垚 `tauri-plugin-updater`
- 鍓嶇 Hook锛歚useUpdater()` 鈥?妫€鏌ユ洿鏂般€佷笅杞借繘搴︺€佸畨瑁?
- UI锛?
  - StatusBar 涓樉绀烘洿鏂版彁绀?
  - 鏇存柊璇︽儏 Dialog锛堢増鏈彿銆丆hangelog銆佷笅杞借繘搴︽潯锛?
- 鍚庣閰嶇疆鏇存柊婧?URL

---

### 2.4 Git 闈㈡澘鍏ㄩ潰澧炲己

**鐜扮姸**锛歏ibeUltra 鏈夊熀纭€ Git 闈㈡澘锛堟殏瀛?鎻愪氦/鎺ㄩ€?鏃ュ織锛夛紝浣嗙己灏?Pull/Fetch銆佸垎鏀鐞嗐€佸寮烘棩蹇椼€佹爲瑙嗗浘绛夊姛鑳姐€?
**MossX 鍙傝€?*锛歚src/features/git/` 鈥?瀹屾暣鐨?Git 绠＄悊妯″潡锛? 绉嶆ā寮忋€佹爲瑙嗗浘銆佸閫夈€丳R 瀹℃煡绛夛級銆?

**璇︾粏璁″垝**锛氳 [`docs/plans/git-panel-enhancement-plan.md`](plans/git-panel-enhancement-plan.md)

**鍒嗛樁娈靛疄鏂?*锛?
- **Phase G1**锛堟牳蹇冿級鈥?Pull/Fetch銆佸垎鏀鐞嗐€佹棩蹇楀寮恒€丗lat/Tree 瑙嗗浘鍒囨崲
- **Phase G2**锛堜氦浜掞級鈥?涓㈠純纭銆丆ommit 鎶樺彔銆侀瑙堟ā鎬佹銆佸鏂囦欢閫夋嫨銆佸彸閿彍鍗?
- **Phase G3**锛圖iff 澧炲己锛夆€?Sticky 鏂囦欢澶淬€佸彉鏇村鑸€丗ull Diff 妯″紡
- **Phase G4**锛圙itHub 闆嗘垚锛夆€?Issues/PRs 妯″紡銆丳R 鏅鸿兘瀵硅瘽銆丄I Commit 娑堟伅

---

## Phase 3 鈥?UI 绮剧粏鍖?

> 鐩爣锛氬弬鑰?MossX 鐨勮璁¤瑷€锛屽叏闈㈡彁鍗?VibeX 鐨勮瑙夊搧璐ㄣ€?

### 3.1 闈㈡澘鏍囩浼樺寲

**鐜扮姸**锛歞ockview 榛樿鏍囩鏍峰紡锛岀己灏戠簿鑷存劅銆?
**MossX 鍙傝€?*锛氱揣鍑戠殑 PanelTabs 璁捐锛?3px 鍥炬爣銆?px 闂磋窛銆佹縺娲绘€佹湁寰鍏夋檿銆?

**瀹炵幇瑕佺偣**锛?
```css
.panel-tab {
  min-width: 20px;
  min-height: 20px;
  padding: 2px;
  color: var(--text-muted);
  transition: color 160ms ease, opacity 160ms ease;
}

.panel-tab.is-active {
  background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
  color: var(--accent-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 46%, transparent);
  border-radius: 6px;
}

.panel-tab-icon svg {
  width: 13px;
  height: 13px;
  stroke-width: 2.2;
}
```

---

### 3.2 渚ф爮 (Sidebar) 閲嶈璁?

**鐜扮姸**锛欰ctivityBar 浠呬负 40px 鍥炬爣鏍忥紝宸︽爮闈㈡澘鏍峰紡杈冩湸绱犮€?
**MossX 鍙傝€?*锛氱簿鑷寸殑渚ф爮璁捐锛屽渾瑙掕銆佹偓鍋滄€併€佸眰绾х缉杩涖€?

**瀹炵幇瑕佺偣**锛?
- 渚ф爮琛岄珮缁熶竴锛氬伐浣滃尯 32px銆佺嚎绋?30px
- 鍦嗚锛?px锛坄--sidebar-row-radius`锛?
- 鎮仠鎬侊細`background: var(--surface-hover); border-radius: 8px`
- 婵€娲绘€侊細宸︿晶 2px 钃濊壊鎸囩ず鏉?
- 鍒嗙粍鏍囬锛氬ぇ鍐欏瓧姣嶃€?0px 瀛楀彿銆乣--text-faint` 棰滆壊
- 鍙姌鍙犲垎缁勶紝甯﹀钩婊戝姩鐢?

---

### 3.3 閫氱煡/Toast 绯荤粺鍗囩骇

**鐜扮姸**锛氬熀纭€ Alert 缁勪欢锛岀己灏戠簿鑷寸殑 Toast 閫氱煡銆?
**MossX 鍙傝€?*锛氬眳涓脊鍑虹殑 Approval Toast锛屽甫浠ｇ爜棰勮銆佺（鐮傝儗鏅€?

**瀹炵幇瑕佺偣**锛?
- 鏉冮檺瀹℃壒 Toast锛圓I 璇锋眰鎵ц鎿嶄綔鏃跺脊鍑猴級锛?
  ```css
  .approval-toast {
    background: var(--surface-card);
    border-radius: 12px;
    border: 1px solid var(--border-subtle);
    padding: 12px;
    box-shadow: 0 16px 32px rgba(0, 0, 0, 0.25);
    animation: toast-in 0.2s ease-out;
  }
  ```
- 浠ｇ爜棰勮鍖哄煙锛氱瓑瀹藉瓧浣撱€?px 鍐呰竟璺濄€?60px 鏈€澶ч珮搴?
- 鎿嶄綔鎸夐挳锛欰llow / Deny / Always Allow
- 鑳屾櫙閬僵锛歚backdrop-blur-sm` 纾ㄧ爞鏁堟灉

---

### 3.4 瀵硅瘽妗?寮瑰嚭妗嗗姩鐢?

**鐜扮姸**锛欴ialog 浣跨敤鍩虹鍑虹幇/娑堝け锛屾棤杩囨浮鍔ㄧ敾銆?
**MossX 鍙傝€?*锛歴cale + fade 缁勫悎鍔ㄧ敾锛岀（鐮傝儗鏅€?

**瀹炵幇瑕佺偣**锛?
```css
/* 寮瑰嚭妗?*/
[data-state="open"] {
  animation: dialog-in 200ms ease-out;
}
[data-state="closed"] {
  animation: dialog-out 150ms ease-in;
}

@keyframes dialog-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* 鑳屾櫙閬僵 */
.dialog-backdrop {
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(4px);
}
```

---

### 3.5 鍔犺浇鐘舵€佷紭鍖?

**鐜扮姸**锛氫娇鐢?Loader2 鏃嬭浆鍥炬爣锛岀己灏戦鏋跺睆鍜屽懠鍚稿姩鐢汇€?
**MossX 鍙傝€?*锛氫赴瀵岀殑鍔犺浇鍔ㄧ敾锛坰himmer銆乥reathing銆乻pin锛夈€?

**瀹炵幇瑕佺偣**锛?
- **楠ㄦ灦灞忕粍浠?* `<Skeleton />`锛?
  ```css
  .skeleton {
    background: linear-gradient(90deg,
      var(--surface-card) 25%,
      var(--surface-hover) 50%,
      var(--surface-card) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
  }
  ```
- **宸ュ叿鎵ц鍛煎惛鍔ㄧ敾**锛?
  ```css
  @keyframes tool-breathing {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
  ```
- 鐢ㄤ簬锛氶潰鏉垮姞杞姐€佹秷鎭祦绛夊緟銆佹枃浠舵爲鍔犺浇

---

### 3.6 瀛椾綋绯荤粺浼樺寲

**鐜扮姸**锛氫娇鐢?IBM Plex Sans/Mono锛屽彲杩涗竴姝ヤ紭鍖栥€?
**MossX 鍙傝€?*锛氱郴缁熷瓧浣撲紭鍏?+ SF Mono 浠ｇ爜瀛椾綋銆?

**寤鸿**锛?
```css
:root {
  /* UI 瀛椾綋锛氱郴缁熷瓧浣撴爤锛堟洿蹇姞杞姐€佹洿濂藉钩鍙板師鐢熸劅锛?*/
  --ui-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                     "Segoe UI", system-ui, sans-serif;

  /* 浠ｇ爜瀛椾綋锛氫繚鐣?IBM Plex Mono 鎴栧垏鎹负鏇寸揣鍑戠殑 JetBrains Mono */
  --code-font-family: "JetBrains Mono", "SF Mono", "IBM Plex Mono",
                       "Cascadia Code", Menlo, monospace;
  --code-font-size: 12px;
  --code-line-height: 1.4;
}
```

---

## Phase 4 鈥?楂樼骇鍔熻兘

> 鐩爣锛氬紩鍏ュ樊寮傚寲楂樼骇鐗规€э紝鎻愬崌浜у搧绔炰簤鍔涖€?

### 4.1 璇煶杈撳叆 (Dictation)

**鐜扮姸**锛歏ibeUltra 鏃犳鍔熻兘銆?
**MossX 鍙傝€?*锛歚src-tauri/src/dictation/` 鈥?Whisper 鏈湴璇煶杞枃瀛椼€?

**瀹炵幇瑕佺偣**锛?
- Rust 鍚庣锛?
  - 闆嗘垚 `whisper-rs`锛坢acOS/Linux锛?
  - Windows 浣跨敤 Stub 鎴栫郴缁?API
  - `cpal` 璺ㄥ钩鍙伴煶棰戦噰闆?
- 鍓嶇锛?
  - 杈撳叆妗嗘梺娣诲姞楹﹀厠椋庢寜閽?
  - 褰曢煶鎸囩ず鍣紙娉㈠舰/鑴夊啿鍔ㄧ敾锛?
  - 褰曢煶缁撴潫鍚庤嚜鍔ㄨ浆鏂囧瓧濉叆杈撳叆妗?
- 娉ㄦ剰锛歐indows 骞冲彴 Whisper 鏀寔鍙兘闇€瑕侀澶栭€傞厤

---

### 4.2 Spec Hub锛堣鑼冪鐞嗭級

**鐜扮姸**锛歏ibeUltra 鏃犳鍔熻兘銆?
**MossX 鍙傝€?*锛歚src/features/spec/` 鈥?瑙勮寖鏂囨。绠＄悊銆?

**瀹炵幇瑕佺偣**锛?
- 鏂板 dockview 闈㈡澘锛歚DockviewSpecPanel`
- 鏀寔鍒涘缓/缂栬緫椤圭洰瑙勮寖鏂囨。
- Markdown 缂栬緫 + 瀹炴椂棰勮
- 瑙勮寖鍙綔涓?AI 涓婁笅鏂囨敞鍏ワ紙涓庨」鐩蹇嗙郴缁熻仈鍔級

---

### 4.3 骞惰鎵ц澧炲己

**鐜扮姸**锛歏ibeUltra 宸叉敮鎸佸 Session锛屼絾缂哄皯骞惰鍙鍖栥€?
**MossX 鍙傝€?*锛歚src/features/parallel/` 鈥?澶?Agent 骞惰杩愯銆?

**瀹炵幇瑕佺偣**锛?
- 骞惰鎵ц鐘舵€侀潰鏉匡細鍚屾椂灞曠ず澶氫釜 Agent 杩愯鐘舵€?
- 杩涘害鎸囩ず鍣細姣忎釜 Agent 鐙珛鐨勮繍琛?绛夊緟/瀹屾垚鐘舵€?
- 璧勬簮鍗犵敤鎻愮ず锛氬唴瀛樸€丄PI 璋冪敤娆℃暟
- 涓€閿叏閮ㄥ仠姝?鏆傚仠

---

### 4.4 鑷畾涔夊懡浠ょ郴缁?

**鐜扮姸**锛歏ibeUltra 鏃犺嚜瀹氫箟鍛戒护銆?
**MossX 鍙傝€?*锛歚src/features/commands/` 鈥?鐢ㄦ埛鑷畾涔夊懡浠ゃ€?

**瀹炵幇瑕佺偣**锛?
- 鏀寔鐢ㄦ埛鍒涘缓鑷畾涔夊懡浠わ紙鍚嶇О + 鎵ц鑴氭湰/鎻愮ず璇嶏級
- 閫氳繃鍏ㄥ眬鎼滅储 CommandsProvider 瑙﹀彂
- 鍛戒护鎸佷箙鍖栧埌 SQLite
- 棰勭疆甯哥敤鍛戒护妯℃澘

---

## Phase 5 鈥?鏋舵瀯浼樺寲

> 鐩爣锛氭笎杩涘紡鏀瑰杽浠ｇ爜鏋舵瀯锛屾彁鍗囧彲缁存姢鎬с€?

### 5.1 鍓嶇 Features 妯″潡鍖栵紙娓愯繘寮忥級

**鐜扮姸**锛氭寜绫诲瀷鍒嗘暎锛坈omponents/hooks/stores锛夈€?
**MossX 鍙傝€?*锛氭寜鍔熻兘鍩熺粍缁囷紙features/git/銆乫eatures/search/锛夈€?

**绛栫暐**锛氫笉鍋氬叏閲忛噸鏋勶紝鏂板姛鑳戒竴寰嬮噰鐢?features 妯″紡锛?
```
frontend/src/features/
鈹溾攢鈹€ search/           鈫?Phase 1 鏂板
鈹?  鈹溾攢鈹€ components/
鈹?  鈹溾攢鈹€ hooks/
鈹?  鈹溾攢鈹€ providers/
鈹?  鈹斺攢鈹€ utils/
鈹溾攢鈹€ project-memory/   鈫?Phase 2 鏂板
鈹?  鈹溾攢鈹€ components/
鈹?  鈹溾攢鈹€ hooks/
鈹?  鈹溾攢鈹€ services/
鈹?  鈹斺攢鈹€ utils/
鈹溾攢鈹€ git-history/      鈫?Phase 2 鏂板
鈹溾攢鈹€ dictation/        鈫?Phase 4 鏂板
鈹斺攢鈹€ spec/             鈫?Phase 4 鏂板
```

鏃т唬鐮佹寜闇€杩佺Щ锛屼笉寮哄埗涓€娆℃€ч噸鏋勩€?

---

### 5.2 TaskFollowUpSection 鎷嗗垎

**鐜扮姸**锛氳秴杩?1200 琛岀殑瓒呭ぇ缁勪欢銆?
**MossX 鍙傝€?*锛欳hatInputBox 鎷嗗垎涓哄涓瓙缁勪欢銆?

**鎷嗗垎鏂规**锛?
```
TaskFollowUpSection (瀹瑰櫒, ~200 琛?
鈹溾攢鈹€ DiffStatsBar          鈫?椤堕儴 Diff 缁熻鏍?
鈹溾攢鈹€ TokenUsageIndicator   鈫?Token 浣跨敤鐜囨寚绀哄櫒
鈹溾攢鈹€ SessionSelector       鈫?Session 涓嬫媺閫夋嫨鍣?
鈹溾攢鈹€ ConflictResolver      鈫?鍐茬獊瑙ｅ喅閮ㄥ垎
鈹溾攢鈹€ ReviewCommentsPreview 鈫?浠ｇ爜瀹℃煡璇勮棰勮
鈹溾攢鈹€ MessageQueue          鈫?娑堟伅闃熷垪鎸囩ず鍣?
鈹溾攢鈹€ ComposerInput         鈫?WYSIWYG 缂栬緫鍣ㄥ皝瑁?
鈹斺攢鈹€ ActionBar             鈫?搴曢儴鎿嶄綔鎸夐挳鏍?
    鈹溾攢鈹€ ExecutorSelector
    鈹溾攢鈹€ AttachmentButton
    鈹斺攢鈹€ SendButton
```

---

### 5.3 娴嬭瘯鍩虹璁炬柦

**鐜扮姸**锛歏ibeUltra 缂哄皯鍓嶇娴嬭瘯銆?
**MossX 鍙傝€?*锛歏itest + Testing Library锛屾湁鍗曞厓娴嬭瘯鍜岄泦鎴愭祴璇曘€?

**瀹炵幇瑕佺偣**锛?
- 瀹夎 Vitest + @testing-library/react + jsdom
- 閰嶇疆 `vitest.config.ts`
- 浼樺厛涓烘牳蹇?Hook 缂栧啓娴嬭瘯锛?
  - `useLayoutStore` 鈥?甯冨眬鐘舵€?
  - `useClaudeSettings` 鈥?璁剧疆璇诲彇
  - 鍏ㄥ眬鎼滅储鐨?Provider 鈥?鎼滅储閫昏緫
- 鐩爣锛氭柊澧炰唬鐮?80%+ 瑕嗙洊鐜?

---

### 5.4 UI 缁勪欢搴撹ˉ鍏?

**鐜扮姸**锛氬熀纭€ shadcn/ui 缁勪欢锛岀己灏戦儴鍒嗗父鐢ㄧ粍浠躲€?
**MossX 鍙傝€?*锛?2 涓簿璋冪粍浠讹紝CVA 鍙樹綋绯荤粺瀹屽杽銆?

**闇€琛ュ厖鐨勭粍浠?*锛?
| 缁勪欢 | 鐢ㄩ€?| 鍙傝€?|
|------|------|------|
| `Skeleton` | 楠ㄦ灦灞忓姞杞藉崰浣?| 鏂板 |
| `Toast` / `Sonner` | 杞婚噺閫氱煡 | MossX 鐨?toast 绯荤粺 |
| `Kbd` | 蹇嵎閿爣绛?| MossX `kbd.tsx` |
| `Progress` | 杩涘害鏉?| 鏇存柊涓嬭浇銆佷换鍔¤繘搴?|
| `Accordion` | 鎶樺彔闈㈡澘 | 璁剧疆椤甸潰 |
| `ScrollArea` | 鑷畾涔夋粴鍔ㄥ尯鍩?| 鍏ㄥ眬浣跨敤 |
| `Switch` | 寮€鍏虫帶浠?| 璁剧疆椤甸潰 |

---

## 鍚?Phase 浜у嚭娓呭崟

| Phase | 鏍稿績浜у嚭 | 鏂板鏂囦欢鏁?浼? |
|-------|---------|--------------|
| **Phase 1** | 鍏ㄥ眬鎼滅储銆佽緭鍏ュ寮恒€佷富棰樼粺涓€銆佹粴鍔ㄦ潯 | ~15 |
| **Phase 2** | 椤圭洰璁板繂銆乮18n銆佽嚜鍔ㄦ洿鏂般€丟it 鍘嗗彶 | ~30 |
| **Phase 3** | 闈㈡澘鏍囩銆佷晶鏍忋€乀oast銆佸姩鐢汇€侀鏋跺睆銆佸瓧浣?| ~20 |
| **Phase 4** | 璇煶杈撳叆銆丼pec Hub銆佸苟琛屽寮恒€佽嚜瀹氫箟鍛戒护 | ~25 |
| **Phase 5** | Features 妯″潡鍖栥€佺粍浠舵媶鍒嗐€佹祴璇曘€乁I 缁勪欢搴?| ~20 |

---

## 椋庨櫓涓庢敞鎰忎簨椤?

1. **涓婚缁熶竴锛圥hase 1.3锛夐闄╂渶楂?* 鈥?legacy/new 鍙岃建鍒惰縼绉绘秹鍙婂ぇ閲忔枃浠讹紝寤鸿鍒嗘ā鍧楁笎杩涙浛鎹?
2. **椤圭洰璁板繂绯荤粺** 鈥?闇€璁捐濂戒笌 AI 瀵硅瘽鐨勬敞鍏ユ椂鏈哄拰鏍煎紡锛岄伩鍏嶄笂涓嬫枃婧㈠嚭
3. **璇煶杈撳叆** 鈥?Windows 骞冲彴 Whisper 缂栬瘧鍙兘瀛樺湪闂锛屽缓璁厛鏀寔 macOS/Linux
4. **Features 妯″潡鍖?* 鈥?涓ョ涓€娆℃€уぇ閲嶆瀯锛屽彧瀵规柊鍔熻兘閲囩敤鏂扮粨鏋?
5. **缁勪欢鎷嗗垎** 鈥?TaskFollowUpSection 鎷嗗垎闇€纭繚 props drilling 涓嶈繃娣憋紝鍚堢悊浣跨敤 Context

---

## 闄勫綍锛歁ossX 鏍稿績鍙傝€冩枃浠剁储寮?

| 鍔熻兘 | MossX 鏂囦欢璺緞 |
|------|---------------|
| 鍏ㄥ眬鎼滅储 | `src/features/search/` |
| 鎼滅储鎺掑簭 | `src/features/search/ranking/score.ts` |
| 椤圭洰璁板繂 | `src/features/project-memory/` |
| 璁板繂鍒嗙被 | `src/features/project-memory/utils/memoryKindClassifier.ts` |
| 杈撳叆鍘嗗彶 | `src/features/composer/hooks/useInputHistoryStore.ts` |
| 鑱婂ぉ杈撳叆 | `src/features/composer/components/ChatInputBox/` |
| 鍥介檯鍖?| `src/i18n/` |
| 鑷姩鏇存柊 | `src/features/update/hooks/useUpdaterController.ts` |
| Git 鍘嗗彶 | `src/features/git-history/components/` |
| 璇煶杈撳叆 | `src-tauri/src/dictation/` |
| 鏆楄壊涓婚 | `src/styles/themes.dark.css` |
| 浜壊涓婚 | `src/styles/themes.light.css` |
| 甯冨眬 | `src/features/layout/components/DesktopLayout.tsx` |
| 闈㈡澘鏍囩 | `src/features/layout/components/PanelTabs.tsx` |
| 渚ф爮鏍峰紡 | `src/styles/sidebar.css` |
| Toast 鏍峰紡 | `src/styles/approval-toasts.css` |
| 鍩虹缁勪欢 | `src/components/ui/` |
