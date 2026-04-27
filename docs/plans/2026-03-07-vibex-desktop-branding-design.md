# VibeX Desktop Branding Design

## Goal

灏嗗綋鍓嶉」鐩殑妗岄潰绔搧鐗岀粺涓€涓?`VibeX`锛屽苟淇濈暀 `frontend/` 浣滀负 Tauri 鍐呭祵鐣岄潰銆傜Щ闄ょ嫭绔?Web/PWA 鏆撮湶闈紝浣嗕笉鐮村潖妗岄潰绔瀯寤洪摼璺€?

## Scope

### In scope

- 灏嗘闈㈢鐢ㄦ埛鍙鍝佺墝鍚嶆洿鏂颁负 `VibeX`
- 灏?`src-tauri/tauri.conf.json` 涓殑 `productName` 涓庣獥鍙ｆ爣棰樻洿鏂颁负 `VibeX`
- 浣跨敤 `C:/Users/Administrator/Downloads/VibeX_background.png` 鐢熸垚妗岄潰搴旂敤鍥炬爣
- 浣跨敤 `C:/Users/Administrator/Downloads/VibeX.png` 浣滀负搴旂敤鍐呴儴鍝佺墝鍥?
- 鍦ㄨ缃〉澧炲姞鍐呴儴鍝佺墝灞曠ず
- 鏇存柊鍓嶇涓敤鎴峰彲瑙佺殑鍝佺墝鏂囨涓庨〉闈㈡爣棰?
- 绉婚櫎 `frontend/index.html` 涓嫭绔?Web/PWA 鐩稿叧 icon 涓?manifest 寮曠敤

### Out of scope

- 涓嶄慨鏀?`Vibe-kanban-originbase/**`
- 涓嶄慨鏀?npm 鍖呭悕銆丆LI 鍛戒护鍚嶃€丷ust crate 鍚嶃€乀auri `identifier`
- 涓嶄慨鏀瑰閮ㄤ粨搴?URL銆乶pm 鍖呭悕銆佺紦瀛樼洰褰曞悕绛夋妧鏈爣璇?
- 涓嶅垹闄ゆ棫璧勬簮鏂囦欢锛屼紭鍏堣В闄ゅ紩鐢紝闄嶄綆鍥炲綊椋庨櫓

## Constraints

- 褰撳墠鈥滄闈㈢鈥濅緷璧?`frontend/` 鎻愪緵 UI锛屼笉鑳界湡姝ｅ垹闄?`frontend/`
- 闇€瑕佷繚鎸佺幇鏈?Tauri 鏋勫缓鏂瑰紡鍙敤
- 閬靛惊 KISS/YAGNI锛氬彧鏀瑰綋鍓嶆槑纭渶瑕佺殑鍝佺墝灞曠ず鐐癸紝涓嶅仛棰濆鏋舵瀯璋冩暣
- 閬靛惊 DRY锛氬鐢ㄧ粺涓€ `Logo` 缁勪欢鎵胯浇鍐呴儴鍝佺墝鍥句笌鍝佺墝鍚?

## Design

## 1. 鍝佺墝鍏ュ彛缁熶竴

閫氳繃浠ヤ笅鍏ュ彛缁熶竴鍝佺墝锛?

- `frontend/src/components/Logo.tsx`
- `frontend/src/pages/settings/SettingsLayout.tsx`
- `frontend/src/components/welcome/WelcomePage.tsx`
- `frontend/src/components/layout/StatusBar.tsx`
- `frontend/src/contexts/ProjectContext.tsx`
- `src-tauri/tauri.conf.json`

`Logo` 缁勪欢鏀逛负鈥滃浘鏍?+ 鏂囨湰鈥濈殑杞婚噺缁勫悎缁勪欢锛屼緵瀵艰埅鏍忋€佸伐鍏锋爮绛変綅缃鐢紱璁剧疆椤靛ご閮ㄩ澶栧睍绀轰竴娆″唴閮ㄥ搧鐗屽浘锛屾弧瓒斥€滃唴閮ㄩ〉闈娇鐢ㄦ棤鑳屾櫙鐗堚€濈殑瑕佹眰銆?

## 2. 鍥炬爣绛栫暐

- 鏃犺儗鏅浘锛氬鍒跺埌鍓嶇婧愮爜鐩綍锛屼緵 React 鐣岄潰瀵煎叆浣跨敤
- 鏈夎儗鏅浘锛氱敤浜庣敓鎴?Tauri bundle icon 鏂囦欢

浼樺厛浣跨敤鐜版湁 Tauri 宸ュ叿閾剧敓鎴愭爣鍑嗚緭鍑烘枃浠讹紝閬垮厤鎵嬪伐鎷艰 `ico` / `icns`锛屽噺灏戝钩鍙板吋瀹规€ч闄┿€?

## 3. Web 鐙珛鍏ュ彛澶勭悊

淇濈暀 `frontend/index.html` 浣滀负 Tauri WebView 瀹夸富椤碉紝浣嗙Щ闄わ細

- favicon 寮曠敤
- apple-touch-icon 寮曠敤
- `site.webmanifest` 寮曠敤

杩欐牱浠嶅彲鏀寔妗岄潰绔姞杞藉墠绔骇鐗╋紝鍚屾椂閬垮厤缁х画鏆撮湶鐙珛 Web/PWA 鍝佺墝鍏ュ彛銆?

## 4. 鐢ㄦ埛鍙鏂囨澶勭悊鍘熷垯

浠呬慨鏀光€滅敤鎴峰彲瑙佸搧鐗屾枃妗堚€濓紝渚嬪锛?

- 娆㈣繋椤垫爣棰?
- 瀵硅瘽妗嗘杩庤
- 鐘舵€佹爮鍝佺墝鍚?
- 椤甸潰 `<title>`
- PR 榛樿鏍囬涓殑鍝佺墝鍚庣紑

涓嶄慨鏀规妧鏈涔夊瓧绗︿覆锛屼緥濡傦細

- 鍖呭悕 `vibe-kanban`
- 杩滅▼浠撳簱 URL
- 澶栭儴渚濊禆鍚?`vibe-kanban-web-companion`

## 5. 椋庨櫓涓庣紦瑙?

- 椋庨櫓锛氳鏀规妧鏈爣璇嗗鑷存瀯寤烘垨闆嗘垚澶辨晥
  - 缂撹В锛氫粎鏇挎崲鐢ㄦ埛鍙鏂囨湰锛涙妧鏈爣璇嗕繚鐣?
- 椋庨櫓锛氬浘鏍囨枃浠舵牸寮忎笉瀹屾暣瀵艰嚧 Tauri 鎵撳寘澶辫触
  - 缂撹В锛氫娇鐢?Tauri icon 鐢熸垚鍛戒护鐢熸垚鏍囧噯鏂囦欢
- 椋庨櫓锛氬搧鐗屾枃鏈仐婕?
  - 缂撹В锛氬疄鐜板墠鍚庡垎鍒墽琛屽叏鏂囨绱笌瀹氬悜娴嬭瘯

## Verification

- 鏂板鍝佺墝鍥炲綊娴嬭瘯锛屾鏌ュ叧閿睍绀轰綅涓?Web icon/manifest 寮曠敤鏄惁绗﹀悎棰勬湡
- 杩愯 `node --test frontend/tests/branding-desktop-only.test.js`
- 杩愯 `pnpm run frontend:check`
- 杩愯 `pnpm run backend:check`

## Notes

- 鏍规嵁浠撳簱鏍?`AGENTS.md`锛屾湰娆′笉鎵ц `git commit`
- 璁捐鏂囨。涓庤鍒掓枃妗ｄ粎浣滀负鏈瀹炵幇璁板綍淇濆瓨鍦?`docs/plans/`
