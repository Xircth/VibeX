# VibeX 闅愬舰闂瀹℃煡涓庝紭鍖栨姤鍛?

瀹℃煡鏃ユ湡锛?026-03-19锛堝懆鍥涳級

## 1) 瀹℃煡鑼冨洿涓庢柟娉?

鏈閽堝褰撳墠宸ヤ綔鍖虹姸鎬佽繘琛屼簡鈥滃彲澶嶇幇妫€鏌?+ 灏忚寖鍥撮珮浠峰€间慨澶嶁€濓紝閲嶇偣鍏虫敞锛?

- 缂栬瘧/绫诲瀷灞傚彲瑙侀棶棰橈紙`frontend:check`銆乣backend:check`锛?
- 璐ㄩ噺闂ㄧ闃绘柇椤癸紙`frontend:lint`銆乣backend:lint`锛?
- 瀹规槗琚拷鐣ヤ絾浼氬湪 CI 鎴栬繍琛屾椂鏀惧ぇ鐨勯棶棰橈紙缂栫爜銆佹鍒欍€佺姸鎬佹竻鐞嗐€佹祦鐩戝惉渚濊禆锛?

鎵ц鍛戒护锛堝叧閿級锛?

- `pnpm run frontend:check` 鉁?
- `pnpm run backend:check` 鉁?
- `pnpm run frontend:lint` 鉂岋紙76 椤癸細66 errors / 10 warnings锛?
- `pnpm run backend:lint` 鉂岋紙褰撳墠涓昏闃绘柇鍦?`crates/git/src/lib.rs` 鐨?Clippy 瑙勫垯锛?
- 瀹氬悜鏍￠獙锛?
  - `pnpm exec eslint`锛堜粎閽堝鏈淇鐩稿叧鍓嶇鏂囦欢锛夆渽

---

## 2) 宸插畬鎴愪紭鍖栵紙鏈钀藉湴锛?

### A. Rust / 鏋勫缓閾捐矾

1. 淇 `manual_find` Clippy 闃绘柇锛堟瀯寤鸿剼鏈級
   - 鏂囦欢锛歚src-tauri/build.rs`
   - 澶勭悊锛氬皢鎵嬪姩 `for` 鏌ユ壘鏀逛负杩唬鍣?`.find(...)`
   - 浠峰€硷細娑堥櫎 QA 妯″紡涓?`-D warnings` 鐨勯樆鏂紝鎻愬崌 CI 绋冲畾鎬с€?

2. 淇 `useless_conversion`锛圥ATH 鑱氬悎閫昏緫锛?
   - 鏂囦欢锛歚crates/utils/src/shell.rs`
   - 澶勭悊锛氱Щ闄ら噸澶?`OsString::from` 杞崲锛堝紓姝?闃诲涓ゅ锛?
   - 浠峰€硷細鍑忓皯鏃犳剰涔夎浆鎹紝閬垮厤 Clippy 鎶ラ敊锛屼唬鐮佹洿鐩存帴銆?

### B. Frontend / 闅愬舰绋冲畾鎬?

3. 娑堥櫎甯搁噺寰幆鏉′欢鍛婅锛岄檷浣庤鍒も€滄綔鍦ㄦ寰幆鈥濋闄?
   - 鏂囦欢锛歚frontend/src/components/file-tree/file-tree-utils.ts`
   - 澶勭悊锛歚while (true)` 鏀逛负鍙鐨?`canCollapse` 缁堟鎺у埗銆?

4. 淇娴佽闃呭弬鏁拌В鏋愪笌 ESLint 鎸囦护杩濊
   - 鏂囦欢锛歚frontend/src/hooks/useTauriPatchStream.ts`
   - 澶勭悊锛氭敼涓轰粎渚濊禆 `argsKey` 鍙嶅簭鍒楀寲鍙傛暟锛岀Щ闄ょ姝㈢殑 `eslint-disable` 娉ㄩ噴銆?

5. 淇 store 娓呯悊閫昏緫涓殑鈥滃崰浣嶅彉閲忔湭浣跨敤鈥濋棶棰?
   - 鏂囦欢锛?
     - `frontend/src/stores/useAiDevServerStartStore.ts`
     - `frontend/src/stores/useTerminalStore.ts`
   - 澶勭悊锛氱敱瑙ｆ瀯涓㈠純鏀逛负娴呮嫹璐濆悗 `delete`銆?
   - 浠峰€硷細娑堥櫎 lint error锛岃涔夋洿鏄庣‘銆?

6. 淇 POSIX 璺緞姝ｅ垯鏃犳晥杞箟锛屽苟娓呯悊 AI 鍚姩鎻愮ず鏂囨湰
   - 鏂囦欢锛歚frontend/src/hooks/useAiHostedDevServerStart.ts`
   - 澶勭悊锛氬幓鎺夋棤鎰忎箟杞箟锛涘皢寮傚父涔辩爜鎻愮ず鏇挎崲涓哄彲璇昏嫳鏂囨彁绀恒€?
   - 浠峰€硷細鍑忓皯姝ｅ垯璇姤涓庢彁绀鸿瘝涓嶅彲璇诲鑷寸殑琛屼负鍋忓樊銆?

---

## 3) 褰撳墠浠嶅瓨鍦ㄧ殑涓昏闅愬舰闂锛堝緟鍚庣画鎵归噺娌荤悊锛?

### A. 鍓嶇 Lint 浠嶆湁杈冨瀛橀噺闂

`pnpm run frontend:lint` 浠嶆姤 76 椤癸紙66 errors / 10 warnings锛夛紝涓昏绫诲瀷锛?

- 澶ч噺鏈娇鐢ㄥ弬鏁?鍙橀噺锛坄_props`, `_event`, `_file`, `_workspaceId` 绛夛級
- 鍛藉悕瑙勮寖鍐茬獊锛堝 `frontend/src/lib/tauri-api.ts` 鏂囦欢鍛藉悕瑙勫垯锛?
- Hook 渚濊禆涓?ref 娓呯悊鍛婅
- 涓埆瑙勫垯杩濊锛堝 `no-constant-condition`銆乣eslint-comments/no-use` 鐨勫叾浠栦綅缃級

### B. 鍚庣 Clippy 浠嶆湁闆嗕腑闃绘柇锛圙it crate锛?

`pnpm run backend:lint` 鐩墠涓昏鍓╀綑鍦細

- `crates/git/src/lib.rs`锛歚collapsible_if`銆乣manual_flatten`銆乣explicit_counter_loop`銆乣redundant_closure` 绛夛紙鏈妫€娴嬪埌 11 椤癸級銆?

> 璇存槑锛氭湰娆″凡鍏堟竻闄ゆ柊澧?楂樻敹鐩婇樆鏂偣锛坄src-tauri/build.rs` 涓?`crates/utils/src/shell.rs`锛夛紝鍏朵綑灞炰簬瀛橀噺椋庢牸鍊哄姟锛屽缓璁互鈥滄壒澶勭悊閲嶆瀯 PR鈥濋泦涓В鍐炽€?

---

## 4) 寤鸿鐨勫悗缁不鐞嗛『搴?

1. **鍏堟竻 Clippy 闃绘柇锛圧ust锛?*
   - 鐩爣锛氳 `pnpm run backend:lint` 鍏ㄧ豢銆?
   - 寤鸿鍏堝鐞?`crates/git/src/lib.rs` 鎶ラ敊闆嗕腑娈碉紝鏀剁泭鏈€楂樸€?

2. **鎸夌洰褰曞垎鎵规竻 Frontend Lint**
   - 寤鸿椤哄簭锛歚hooks` 鈫?`lib/api` 鈫?`components/panels` 鈫?`stores`銆?
   - 姣忔壒鎺у埗鍦?10~20 涓棶棰橈紝闄嶄綆鍥炲綊椋庨櫓銆?

3. **寤虹珛鈥滃閲忛浂璐熷€衡€濋棬绂?*
   - 鏂版敼鍔ㄦ枃浠惰姹?lint/clippy 闆舵柊澧為棶棰橈紱
   - 瀛橀噺闂閲囩敤鐧藉悕鍗曢€掑噺绛栫暐锛岄伩鍏嶄竴娆℃€уぇ鐖嗙偢鏀归€犮€?

---

## 5) 鏈缁撹

椤圭洰褰撳墠鈥滃彲缂栬瘧銆佸彲绫诲瀷妫€鏌モ€濓紝浣嗚川閲忛棬绂侊紙lint/clippy锛夊瓨鍦ㄦ槑鏄惧瓨閲忓€哄姟銆? 
鏈宸插畬鎴愪竴杞珮浠峰€尖€滈殣褰㈤棶棰樷€濅慨澶嶏紝浼樺厛瑙ｅ喅浜嗕細鍦?CI/缁存姢涓斁澶х殑鍏抽敭鐐癸紝骞剁粰鍑哄悗缁彲鎵ц娌荤悊璺緞銆?

