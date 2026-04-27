# VibeX

> 鍩轰簬 [vibe-kanban](https://github.com/BloopAI/vibe-kanban) fork锛岄拡瀵规闈㈢浣撻獙娣卞害浼樺寲鐨?AI 缂栫▼ Agent 浠诲姟绠＄悊宸ュ叿銆?

<p align="center">
<img src="frontend/src/assets/vibex_logo.png" alt="VibeX Logo" width="200">
</p>

<p align="center">
  璁?Claude Code銆丟emini CLI銆丆odex銆丄mp 绛?AI 缂栫▼ Agent 鐨勭敓浜у姏鎻愬崌 10 鍊?
</p>

---

## 绠€浠?

VibeX 鏄竴涓笓涓?AI 杈呭姪缂栫▼宸ヤ綔娴佽璁＄殑妗岄潰浠诲姟绠＄悊搴旂敤锛屽熀浜?Tauri v2 鏋勫缓銆傚畠瑙ｅ喅浜嗗湪浣跨敤澶氫釜 AI 缂栫▼ Agent 鏃堕潰涓寸殑鍗忚皟銆佽拷韪拰瀹℃煡闂锛岃浣犱笓娉ㄤ簬瑙勫垝涓庡喅绛栵紝鑰岄潪绻佺悙鐨勪笂涓嬫枃鍒囨崲銆?

### 鏍稿績鍔熻兘

- **澶?Agent 骞惰璋冨害** 鈥?鍚屾椂杩愯澶氫釜 AI 缂栫▼ Agent锛屼覆琛屾垨骞惰鎵ц浠诲姟
- \*_鐪嬫澘寮忎换鍔＄鐞?_ 鈥?鐩磋杩借釜姣忎釜 Agent 鐨勫伐浣滅姸鎬?
- **鍐呯疆缁堢闆嗘垚** 鈥?鏃犻渶鍒囨崲绐楀彛锛岀洿鎺ュ湪搴旂敤鍐呮煡鐪?Agent 杈撳嚭
- \*_浠ｇ爜棰勮涓庢鏌?_ 鈥?瀹炴椂棰勮 Agent 鐢熸垚鐨勪唬鐮侊紝鏀寔鍘熺敓 DevTools 璋冭瘯
- **缁熶竴 MCP 閰嶇疆** 鈥?闆嗕腑绠＄悊鎵€鏈?Agent 鐨?MCP锛圡odel Context Protocol锛夐厤缃?
- **Git Worktree 闅旂** 鈥?鑷姩涓烘瘡涓换鍔″垱寤虹嫭绔嬬殑 git worktree锛岄伩鍏嶅垎鏀啿绐?

---

## 蹇€熷紑濮?

### 绯荤粺瑕佹眰

- [Rust](https://rustup.rs/)锛堟渶鏂扮ǔ瀹氱増锛?
- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 8

### 瀹夎渚濊禆

```bash
pnpm install
```

### 鍚姩寮€鍙戞ā寮?

```bash
pnpm run dev
```

绛変环鍛戒护锛?

```bash
pnpm run dev:desktop
```

> 榛樿浠ユ闈㈡ā寮忓惎鍔ㄣ€傚紑鍙戞椂浼氬惎鍔?Vite dev server 骞堕€氳繃 Tauri `devUrl` 杩炴帴锛屾敮鎸?HMR锛孋PU 鍗犵敤涔熸槑鏄句綆浜?`vite build --watch` 妯″紡銆?

### 浠呮瀯寤哄墠绔?

```bash
cd frontend && pnpm build
```

---

## 棰濆寮€鍙戝伐鍏?

```bash
cargo install cargo-watch
cargo install sqlx-cli
```

---

## 鍏充簬鏈」鐩?

VibeX 鏄?vibe-kanban 鐨勭嫭绔?fork锛屼笓娉ㄤ簬妗岄潰绔師鐢熶綋楠屼紭鍖栵紝鍘婚櫎浜嗕簯鍚屾銆丱Auth 绛夌涓夋柟渚濊禆锛屼繚鎸佽交閲忋€佺鏈夈€佸彲鑷墭绠°€?

涓婃父椤圭洰锛歔BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
