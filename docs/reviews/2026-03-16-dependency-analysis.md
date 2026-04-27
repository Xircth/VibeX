# VibeX 渚濊禆鍐椾綑鍒嗘瀽鎶ュ憡

> 鍒嗘瀽鏃ユ湡: 2026-03-16 (绗簩杞?
> 瀹℃煡鑼冨洿: `frontend/package.json`銆乣src-tauri/Cargo.toml`銆佸悇 `crates/*/Cargo.toml`
> 鎬讳綋璇勭骇: **璀﹀憡**

---

## 涓€銆佸墠绔浂浣跨敤/鍙Щ闄や緷璧?

### 1.1 绔嬪嵆鍙Щ闄?

| 渚濊禆 | 绫诲瀷 | 棰勪及鑺傜渷 | 璇存槑 |
|------|------|----------|------|
| `@ibm/plex` | devDep | **~30MB node_modules** | 瀛椾綋宸叉湰鍦板寲涓?woff2 鍦?`public/fonts/`锛宯pm 鍖呯函鍐椾綑 |
| `@tailwindcss/container-queries` | dep | 鏋佸皬 | Tailwind 閰嶇疆涓敞鍐屼絾闆?`@container` 浣跨敤 |

### 1.2 闇€纭鍚庣Щ闄?

| 渚濊禆 | 璇存槑 |
|------|------|
| `@tauri-apps/plugin-shell` | 鍓嶇闆跺鍏ワ紝鍙兘浠?Rust 渚т娇鐢?|
| `react-compiler-runtime` | React Compiler 杩愯鏃讹紝鐢?babel 鎻掍欢鑷姩娉ㄥ叆銆傝嫢鏈惎鐢?React Compiler 鍒欏彲绉婚櫎 |

---

## 浜屻€佸姛鑳介噸鍙犱緷璧栫粍

### 2.1 [鍏抽敭] 鍥炬爣搴?-- 涓夊簱骞跺瓨

| 搴?| 浣跨敤娆℃暟 | 鍖呬綋绉?|
|----|---------|--------|
| `lucide-react` | **134 澶?* (133 鏂囦欢) | ~200KB (tree-shakable) |
| `@phosphor-icons/react` | **4 澶?* (3 鏂囦欢) | ~500KB (tree-shakable) |
| `developer-icons` | **1 澶?* (1 鏂囦欢) | 鏈煡 |

**寤鸿**: 缁熶竴鍒?`lucide-react`锛屼粎闇€淇敼 3-4 涓枃浠躲€傞浼拌妭鐪?**~500KB+**銆?

### 2.2 [楂榏 浠ｇ爜缂栬緫鍣?-- 涓夊鏂规

| 搴?| 鐢ㄩ€?| 浣跨敤浣嶇疆 |
|----|------|---------|
| `@uiw/react-codemirror` + 4 涓?`@codemirror/*` 鍖?| JSON 缂栬緫鍣?| 浠?1 鏂囦欢 (`json-editor.tsx`) |
| `monaco-editor` + `@monaco-editor/react` | 浠ｇ爜棰勮/Diff | 2 鏂囦欢 |
| `prismjs` | 璇硶楂樹寒 | 浠?1 鏂囦欢 (`syntax.ts`) |

**寤鸿**: 绉婚櫎 CodeMirror 鍏ㄥ锛? 涓寘锛夛紝鐢?Monaco 瀹炵幇 JSON 缂栬緫銆傞浼拌妭鐪?**~300KB**銆?

### 2.3 [涓璢 Diff 娓叉煋 -- 涓夊鏂规

| 搴?| 浣跨敤浣嶇疆 |
|----|---------|
| `@git-diff-view/react` + `@git-diff-view/file` | 3 鏂囦欢 |
| `@pierre/diffs` | 1 鏂囦欢 (`diffDataAdapter.ts`) |
| Monaco 鍐呯疆 diff | 1 鏂囦欢 |

### 2.4 [浣嶿 dockview 涓夊寘

| 鍖?| 瀵煎叆娆℃暟 |
|----|---------|
| `dockview-react` | 16 澶勶紙涓昏浣跨敤锛?|
| `dockview-core` | 1 澶勶紙绫诲瀷瀵煎叆锛?|
| `dockview` | 1 澶勶紙绫诲瀷瀵煎叆锛?|

妫€鏌?`dockview-react` 鏄惁 re-export 鎵€闇€绫诲瀷銆?

---

## 涓夈€佷娇鐢ㄦ瀬灏戝彲鏇夸唬鐨勪緷璧?

| 渚濊禆 | 浣跨敤娆℃暟 | 鏇夸唬鏂规 | 棰勪及鑺傜渷 |
|------|---------|----------|----------|
| `framer-motion` | 3 澶?| CSS transitions/animations | ~150KB |
| `@tanstack/react-form` | 1 澶?| 绠€鍗?useState | ~30KB |
| `react-resizable-panels` | 1 澶?| dockview 宸叉湁甯冨眬鑳藉姏 | ~20KB |
| `embla-carousel-react` | 1 澶?| CSS scroll-snap | ~15KB |
| `react-dropzone` | 1 澶?| HTML5 drag & drop API | ~10KB |

---

## 鍥涖€佷緷璧栧垎绫婚敊璇?

### 搴斾粠 devDependencies 绉诲埌 dependencies

| 渚濊禆 | 鍘熷洜 |
|------|------|
| `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8` | 鍦?10 涓繍琛屾椂鏂囦欢涓瀵煎叆锛屼笉鏄函寮€鍙戝伐鍏?|

### 搴斾粠 dependencies 绉诲埌 devDependencies

| 渚濊禆 | 鍘熷洜 |
|------|------|
| `tailwind-scrollbar` | Tailwind 鎻掍欢锛屼粎鏋勫缓鏃朵娇鐢?|
| `tailwindcss-animate` | Tailwind 鎻掍欢锛屼粎鏋勫缓鏃朵娇鐢?|

---

## 浜斻€丷ust 渚濊禆鍒嗘瀽

### 5.1 搴旀彁鍗囦负 workspace 渚濊禆

| Crate | 鍑虹幇娆℃暟 | 澶囨敞 |
|-------|---------|------|
| `sqlx` | **7 澶?* | features 涓嶄竴鑷达紙鍏抽敭闂锛?|
| `dirs` | 6 澶?| |
| `tokio-util` | 4 澶?| features 涓嶅悓 |
| `tempfile` | 4 澶?| |
| `tokio-stream` | 3 澶?| features 涓嶅悓 |
| `command-group` | 3 澶?| |
| `strum` / `strum_macros` | 3 澶?| |
| `regex` | 3 澶?| |
| `enum_dispatch` | 2 澶?| |
| `rust-embed` | 2 澶?| |
| `shlex` | 2 澶?| |
| `base64` | 2 澶?| |
| `ignore` | 2 澶?| |
| `which` | 2 澶?| |
| `toml` | 2 澶?| |
| `json-patch` | 2 澶?| |

### 5.2 sqlx features 涓嶄竴鑷达紙鍏抽敭锛?

```
db/services/local-deployment: ["runtime-tokio", "tls-rustls-aws-lc-rs", "sqlite",
                                "sqlite-preupdate-hook", "chrono", "uuid"]
src-tauri:                     ["runtime-tokio", "sqlite"]  -- 缂哄皯澶氫釜 features
executors/api-types:           [default-features=false, "derive"]  -- 鏈€灏忓寲
deployment:                    [default-features=false]  -- 鏈€灏忓寲
```

Cargo 鑷姩鍚堝苟 features锛岄€犳垚闅愬紡渚濊禆銆傚簲缁熶竴鍒?workspace 灞傞潰銆?

### 5.3 鍔熻兘閲嶅彔

| 閲嶅彔缁?| 璇存槑 |
|--------|------|
| `dirs` + `directories` + `xdg` | 涓変釜鐩綍璺緞搴撳叡瀛樸€俙dirs`(6 crate) + `directories`(utils) + `xdg`(executors,1澶? |

**寤鸿**: 缁熶竴浣跨敤 `dirs`銆?

### 5.4 缁忛獙璇佹湁浣跨敤鐨勪緷璧?

鎵€鏈夊叾浠?Rust 渚濊禆锛坄base64`銆乣trash`銆乣ignore`銆乣os_info`銆乣which`銆乣ts-rs`銆乣jsonwebtoken`銆乣similar`銆乣shellexpand`銆乣rust-embed`銆乣url`銆乣notify-rust`銆乣backon`銆乣dashmap`銆乣dunce`銆乣sha2`銆乣fst`銆乣moka`銆乣walkdir`銆乣rand`銆乣lru`銆乣derivative`銆乣convert_case`銆乣eventsource-stream`銆乣jsonc-parser`銆乣globwalk`銆乣portable-pty` 绛夛級鍧囨湁瀹為檯浣跨敤銆?

---

## 鍏€佽鍔ㄤ紭鍏堢骇

| 浼樺厛绾?| 鎿嶄綔 | 棰勪及鏃堕棿 | 棰勪及鏀剁泭 |
|--------|------|----------|----------|
| P0 | 绉婚櫎 `@ibm/plex` | 1 鍒嗛挓 | -30MB node_modules |
| P0 | 缁熶竴 sqlx 涓?workspace 渚濊禆 | 30 鍒嗛挓 | 娑堥櫎闅愬紡渚濊禆椋庨櫓 |
| P0 | 淇 `@rjsf/*` 鍒嗙被 (devDep -> dep) | 5 鍒嗛挓 | 淇娼滃湪鏋勫缓闂 |
| P1 | 缁熶竴鍥炬爣搴撳埌 lucide-react | 1 灏忔椂 | -500KB bundle |
| P1 | 鎻愬崌 15+ Rust 渚濊禆涓?workspace 渚濊禆 | 1 灏忔椂 | 鐗堟湰缁熶竴绠＄悊 |
| P2 | 绉婚櫎 CodeMirror 鍏ㄥ | 2 灏忔椂 | -300KB bundle |
| P2 | 绉婚櫎 framer-motion | 1 灏忔椂 | -150KB bundle |
| P2 | 绉诲姩 tailwind 鎻掍欢鍒?devDep | 5 鍒嗛挓 | 鍒嗙被姝ｇ‘ |
| P3 | 绉婚櫎 `@tailwindcss/container-queries` | 5 鍒嗛挓 | 娓呯悊 |
| P3 | 璇勪及绉婚櫎 dockview/dockview-core | 30 鍒嗛挓 | 鍙兘鍑忓皯鍖呬綋绉?|
| P3 | 璇勪及 diff 娓叉煋搴撳悎骞?| 2 灏忔椂 | 鍑忓皯缁存姢璐熸媴 |
| P3 | 缁熶竴 dirs/directories/xdg | 1 灏忔椂 | 鍑忓皯 Rust 渚濊禆 |
