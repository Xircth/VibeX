# Git 闈㈡澘澧炲己璁″垝

> 鍩轰簬 mossx Git 妯″潡鐨勬繁搴﹀璁★紝鍒跺畾 VibeX Git 闈㈡澘鍔熻兘瀵归綈涓庡寮鸿矾绾垮浘銆?
> 鏈鍒掓槸 `improvement-plan.md` Phase 2.4锛圙it 鍘嗗彶鍙鍖栵級鐨勭粏鍖栨墿灞曘€?

---

## 鐜扮姸鎬荤粨

### 宸插疄鐜?

| 鍔熻兘 | 鐘舵€?|
|------|------|
| Staged/Unstaged 鍒嗗尯鏂囦欢鍒楄〃 | 瀹屾垚 |
| 鍗曟枃浠?Stage/Unstage/Revert | 瀹屾垚 |
| 鎵归噺 Stage All / Revert All | 瀹屾垚 |
| Commit 娑堟伅杈撳叆 + Commit/Commit&Push 鎸夐挳 | 瀹屾垚 |
| Push 鎸夐挳锛堝惈 ahead 璁℃暟锛?| 瀹屾垚 |
| Diff 鏌ョ湅鍣紙铏氭嫙婊氬姩 + Split/Unified锛?| 瀹屾垚 |
| 鎻愪氦鏃ュ織瑙嗗浘锛?00 鏉?+ ahead/behind锛?| 瀹屾垚 |
| 鏂囦欢鐘舵€佸窘鏍囷紙A/M/D/R/U锛?| 瀹屾垚 |
| 琛岀骇 +/- 缁熻 | 瀹屾垚 |
| 鍥剧墖 Diff 鐗规畩澶勭悊 | 瀹屾垚 |
| 鑷€傚簲杞 | 瀹屾垚 |

### 鍚庣宸叉湁浣嗗墠绔湭鐢?

| 鍚庣鍛戒护 | 鍔熻兘 | 鍓嶇鐘舵€?|
|----------|------|----------|
| `get_repo_branches` | 鑾峰彇鍒嗘敮鍒楄〃 | API 宸插皝瑁咃紝鍓嶇鏈皟鐢?|
| `get_repo_remotes` | 鑾峰彇杩滅鍒楄〃 | API 宸插皝瑁咃紝鍓嶇鏈皟鐢?|
| `get_workspace_commit_graph` | 鎻愪氦鍥捐氨锛堜袱鍒嗘敮瀵规瘮锛?| 鍓嶇鏈皟鐢?|
| `get_workspace_commit_history` | 鎻愪氦鍘嗗彶 | 鍓嶇鏈皟鐢?|
| `rebase_workspace` | Rebase 鎿嶄綔 | 鍓嶇鏈皟鐢?|
| `merge_workspace` | 鍚堝苟鎿嶄綔 | 鍓嶇鏈皟鐢?|
| `rename_workspace_branch` | 閲嶅懡鍚嶅垎鏀?| 鍓嶇鏈皟鐢?|
| `create_workspace_pr` | 鍒涘缓 PR锛坓h CLI锛?| 鍓嶇鏈皟鐢?|
| `list_open_prs` | 鍒楀嚭寮€鏀?PR | 鍓嶇鏈皟鐢?|

---

## Phase 鍒掑垎

### Phase G1 鈥?Git 闈㈡澘鏍稿績澧炲己锛堥珮浼樺厛绾э級

> 鐩爣锛氳ˉ榻愮敤鎴锋槑纭姹傜殑 4 椤规牳蹇冨姛鑳姐€?
> 棰勪及锛?-5 涓伐浣滄棩

#### G1.1 Pull/Fetch 鎿嶄綔

**缂哄け**锛氬綋鍓嶅彧鏈?Push锛屾棤 Pull/Fetch銆?

**鍚庣鏂板**锛?
- `crates/git/src/lib.rs` 鏂板鏂规硶锛?
  - `pull_from_remote(branch, remote)` 鈥?`git pull --ff-only`锛堥粯璁ゅ揩杩涘悎骞讹級
  - `fetch_remote(remote)` 鈥?`git fetch`
- `src-tauri/src/commands/workspaces.rs` 鏂板鍛戒护锛?
  - `pull_workspace_branch` 鈥?璋冪敤 `pull_from_remote`
  - `fetch_workspace` 鈥?璋冪敤 `fetch_remote`
- `crates/api-types/` 鏂板鍝嶅簲绫诲瀷锛?
  - `PullResult { updated: bool, new_commits: u32, conflicts: Vec<String> }`

**鍓嶇淇敼**锛?
- `frontend/src/lib/api.ts` 鈥?鏂板 `pullBranch()`銆乣fetchRemote()`
- `frontend/src/hooks/git/useGitActions.ts` 鈥?鏂板 `onPull`銆乣onFetch` 鎿嶄綔
- `frontend/src/components/panels/git/GitPanel.tsx` 鈥?宸ュ叿鏍忔柊澧烇細
  - Pull 鎸夐挳锛圖ownload 鍥炬爣锛夆€?褰?`commitsBehind > 0` 鏃堕珮浜樉绀?behind 鏁伴噺
  - Fetch 鎸夐挳锛圧efreshCw 鍥炬爣锛夆€?鑾峰彇杩滅鏈€鏂扮姸鎬?
  - Sync 鎸夐挳锛圓rrowUpDown 鍥炬爣锛夆€?Pull + Push 涓€閿悓姝ワ紙鍙€夛級

**鍙傝€?*锛歮ossx `GitDiffPanel.tsx` Push/Pull/Sync 鎸夐挳鍖恒€?

---

#### G1.2 鍒嗘敮绠＄悊

**缂哄け**锛氭棤娉曟煡鐪?鍒囨崲/鍒涘缓鍒嗘敮銆?

**鍚庣鍒╃敤**锛歚get_repo_branches` 鍛戒护宸插瓨鍦ㄣ€?

**鍚庣鏂板**锛?
- `src-tauri/src/commands/repos.rs` 鎴?`workspaces.rs` 鏂板锛?
  - `checkout_branch { repo_path, branch_name }` 鈥?`git checkout <branch>`
  - `create_branch { repo_path, branch_name, from_ref? }` 鈥?`git checkout -b <name> [from]`
  - `delete_branch { repo_path, branch_name, force }` 鈥?`git branch -d/-D`

**鍓嶇鏂板**锛?
- `frontend/src/hooks/git/useGitBranches.ts` 鈥?鏂?Hook锛?
  ```typescript
  interface UseGitBranches {
    branches: Branch[]
    currentBranch: string
    checkoutBranch: (name: string) => Promise<void>
    createBranch: (name: string) => Promise<void>
    deleteBranch: (name: string, force?: boolean) => Promise<void>
    refreshBranches: () => void
    isLoading: boolean
  }
  ```
- `frontend/src/components/panels/git/GitBranchList.tsx` 鈥?鍒嗘敮鍒楄〃缁勪欢锛?
  - 鏈湴鍒嗘敮 / 杩滅鍒嗘敮鍒嗙粍灞曠ず
  - 褰撳墠鍒嗘敮楂樹寒鏍囪锛堟槦鍙锋垨绮椾綋锛?
  - 鐐瑰嚮鍒囨崲鍒嗘敮
  - 鍙充笂瑙掋€?銆嶆寜閽垱寤烘柊鍒嗘敮
  - 姣忎釜鍒嗘敮琛屾偓鍋滄樉绀烘搷浣滄寜閽紙checkout / delete锛?
  - 鎺掑簭锛氭寜鏈€杩戞彁浜ゆ椂闂撮檷搴忥紙鍒╃敤 `last_commit_date`锛?
- `GitPanel.tsx` 闈㈡澘妯″紡鏂板 `branches` Tab

**鍙傝€?*锛歮ossx `useGitBranches.ts`銆?

---

#### G1.3 鎻愪氦鏃ュ織澧炲己

**缂哄け**锛歀og 瑙嗗浘缂哄皯 To Push/To Pull 鍒嗗尯鍜屽彸閿搷浣溿€?

**鍓嶇淇敼**锛?
- `frontend/src/components/panels/git/GitLogView.tsx` 鈥?澧炲己锛?
  1. **涓夊垎鍖哄竷灞€**锛?
     - "To Push"锛坄commitsAhead > 0` 鏃舵樉绀猴級鈥?寰呮帹閫佹彁浜ゅ垪琛?
     - "To Pull"锛坄commitsBehind > 0` 鏃舵樉绀猴級鈥?寰呮媺鍙栨彁浜ゅ垪琛?
     - "Recent Commits" 鈥?鍏ㄩ儴鎻愪氦鍘嗗彶
  2. **鍙抽敭涓婁笅鏂囪彍鍗?*锛圱auri 鍘熺敓鑿滃崟锛夛細
     - `Copy SHA` 鈥?澶嶅埗瀹屾暣 SHA 鍒板壀璐存澘
     - `Open on GitHub` 鈥?濡傛湁 remote URL锛屾墦寮€ `{githubUrl}/commit/{sha}`
  3. **鎻愪氦璇︽儏灞曞紑**锛?
     - 鐐瑰嚮鎻愪氦琛屽睍寮€鏄剧ず璇ユ彁浜ょ殑鏂囦欢鍙樻洿鍒楄〃
     - 鏄剧ず姣忎釜鏂囦欢鐨?+/- 缁熻
     - 鐐瑰嚮鏂囦欢鍙湪 Diff 鏌ョ湅鍣ㄤ腑棰勮

**鍚庣鍒╃敤**锛?
- `get_workspace_git_log` 宸茶繑鍥?`ahead_entries` / `behind_entries`锛屽墠绔彧闇€鍒嗗尯娓叉煋
- `get_workspace_commit_history` 宸插瓨鍦紝鍙敤浜庤幏鍙栬缁嗘彁浜や俊鎭?

**鍙傝€?*锛歮ossx `GitLogEntryRow` + 鍙抽敭鑿滃崟銆?

---

#### G1.4 Flat/Tree 瑙嗗浘鍒囨崲

**缂哄け**锛氭枃浠跺垪琛ㄤ粎鏈夋墎骞冲垪琛紝鏃犵洰褰曟爲瑙嗗浘銆?

**鍓嶇鏂板**锛?
- `frontend/src/components/panels/git/GitFileTree.tsx` 鈥?鐩綍鏍戠粍浠讹細
  - `buildDiffTree(files)` 鈥?灏嗘墎骞虫枃浠跺垪琛ㄦ瀯寤轰负鏍戠粨鏋?
  - 鏂囦欢澶硅妭鐐瑰彲鎶樺彔/灞曞紑锛圕hevronRight/ChevronDown锛?
  - 缂╄繘锛?0px/灞?
  - 姣忎釜鏂囦欢澶规樉绀哄寘鍚殑鍙樻洿鏂囦欢鏁伴噺
  - 鏂囦欢鑺傜偣澶嶇敤 `GitFileRow` 鐨勬搷浣滄寜閽?
- `frontend/src/components/panels/git/GitStagingArea.tsx` 鈥?淇敼锛?
  - 椤堕儴鏂板 Flat/Tree 鍒囨崲鎸夐挳锛圠ayoutGrid / FolderTree 鍥炬爣锛?
  - 鐘舵€佹寔涔呭寲鍒?`useLayoutStore`
  - 蹇嵎閿細`Alt+Shift+V` 鍒囨崲

**鍙傝€?*锛歮ossx `DiffTreeSection` + `buildDiffTree`銆?

---

### Phase G2 鈥?浜や簰浣撻獙澧炲己锛堜腑浼樺厛绾э級

> 鐩爣锛氬榻?mossx 鐨勪氦浜掔粏鑺傦紝鎻愬崌鎿嶄綔鏁堢巼銆?
> 棰勪及锛?-3 涓伐浣滄棩

#### G2.1 涓㈠純纭寮圭獥

**缂哄け**锛歊evert/Discard 鎿嶄綔鏃犵‘璁わ紝鍙兘瀵艰嚧璇搷浣溿€?

**鍓嶇鏂板**锛?
- `frontend/src/components/panels/git/GitDiscardDialog.tsx`锛?
  - 璀﹀憡鏂囧瓧锛?姝ゆ搷浣滀笉鍙€?
  - 鍙楀奖鍝嶆枃浠跺垪琛紙`<code>` 鏍囩锛?
  - Cancel / Confirm 鎸夐挳
  - 鎻愪氦涓鐢ㄦ寜閽?+ loading 鐘舵€?
- 淇敼 `GitStagingArea.tsx`锛歊evert 鍗曟枃浠?/ Revert All 瑙﹀彂寮圭獥

**鍙傝€?*锛歮ossx `diff-danger-dialog`銆?

---

#### G2.2 Commit 鍖哄煙鎶樺彔

**缂哄け**锛欳ommit 妗嗗缁堟樉绀猴紝鍗犵敤闈㈡澘绌洪棿銆?

**鍓嶇淇敼**锛?
- `GitPanel.tsx` 鎴?`GitCommitBox.tsx`锛?
  - 娣诲姞鎶樺彔/灞曞紑鎸夐挳锛圕hevronsUpDown / ChevronsDownUp锛?
  - 榛樿灞曞紑锛屾姌鍙犳椂浠呮樉绀轰竴琛屾彁绀?
  - 鐘舵€佹寔涔呭寲

---

#### G2.3 鏂囦欢棰勮妯℃€佹

**缂哄け**锛氭棤娉曞叏灞忔煡鐪嬪崟鏂囦欢 Diff銆?

**鍓嶇鏂板**锛?
- `frontend/src/components/panels/git/GitDiffModal.tsx`锛?
  - 鍙屽嚮 `GitFileRow` 瑙﹀彂
  - Portal 鍒?`document.body`
  - 鏂囦欢鐘舵€?+ 璺緞 + +/-缁熻 鏍囬鏍?
  - 鏈€澶у寲/杩樺師鎸夐挳
  - 鍏抽棴鎸夐挳 + ESC 蹇嵎閿?
  - 鍐呭祵瀹屾暣 `GitDiffViewer`锛堟敮鎸?split/unified 鍒囨崲锛?

**鍙傝€?*锛歮ossx `git-history-diff-modal`銆?

---

#### G2.4 澶氭枃浠堕€夋嫨

**缂哄け**锛氬彧鑳藉崟涓搷浣滄枃浠讹紝鏃犳硶鎵归噺閫変腑銆?

**鍓嶇淇敼**锛?
- `GitStagingArea.tsx` 鏂板閫変腑鐘舵€佺鐞嗭細
  - 鍗曞嚮锛氶€変腑鍗曟枃浠?
  - `Ctrl/Cmd + Click`锛氳拷鍔?绉婚櫎閫変腑
  - `Shift + Click`锛氳寖鍥撮€変腑
- 閫変腑鏂囦欢楂樹寒鏍峰紡
- 鎵归噺鎿嶄綔锛氶€変腑澶氫釜鏂囦欢鍚庝竴閿?Stage/Unstage/Discard

---

#### G2.5 鍙抽敭涓婁笅鏂囪彍鍗曪紙鏂囦欢鍒楄〃锛?

**缂哄け**锛氭枃浠跺垪琛ㄦ棤鍙抽敭鑿滃崟銆?

**鍓嶇鏂板**锛?
- 浣跨敤 Tauri 鍘熺敓鑿滃崟 API锛坄@tauri-apps/plugin-menu`锛?
- 鑿滃崟椤规牴鎹枃浠剁姸鎬佸姩鎬佺敓鎴愶細
  - Staged 鏂囦欢锛歚Unstage file(s) (N)`
  - Unstaged 鏂囦欢锛歚Stage file(s) (N)` / `Discard change(s) (N)`
- 澶氶€夋椂鏄剧ず鎿嶄綔鏁伴噺

**鍙傝€?*锛歮ossx 鍙抽敭鑿滃崟瀹炵幇銆?

---

### Phase G3 鈥?Diff 鏌ョ湅鍣ㄥ寮猴紙涓紭鍏堢骇锛?

> 鐩爣锛氭彁鍗?Diff 闃呰浣撻獙锛屽榻?mossx 鐨勯珮绾ф祻瑙堝姛鑳姐€?
> 棰勪及锛?-3 涓伐浣滄棩

#### G3.1 Sticky 鏂囦欢澶?

**缂哄け**锛氭粴鍔?Diff 鏃朵笉鐭ラ亾褰撳墠鏌ョ湅鐨勬槸鍝釜鏂囦欢銆?

**鍓嶇淇敼**锛?
- `GitDiffViewer.tsx`锛?
  - 婊氬姩鏃堕€氳繃 `IntersectionObserver` 鎴?`scrollTop` 璁＄畻褰撳墠鍙鏂囦欢
  - 椤堕儴鍥哄畾鏄剧ず褰撳墠鏂囦欢璺緞 + 鐘舵€?+ +/-缁熻
  - 骞虫粦鍒囨崲鍔ㄧ敾

**鍙傝€?*锛歮ossx Sticky 鏂囦欢澶村疄鐜般€?

---

#### G3.2 Change Anchor 瀵艰埅

**缂哄け**锛氬湪闀?Diff 涓棤娉曞揩閫熻烦杞埌鍙樻洿浣嶇疆銆?

**鍓嶇鏂板**锛?
- `GitDiffViewer.tsx` 宸ュ叿鏍忔柊澧烇細
  - 涓婁竴涓彉鏇达紙ChevronUp锛? 涓嬩竴涓彉鏇达紙ChevronDown锛夋寜閽?
  - 褰撳墠浣嶇疆 `N/M` 鏄剧ず
  - 鎵弿 `[data-line-type="change-*"]` DOM 鍏冪礌瀹氫綅
  - `scrollIntoView({ behavior: "smooth", block: "center" })`

**鍙傝€?*锛歮ossx Change Anchors 瀹炵幇銆?

---

#### G3.3 Full Diff 妯″紡

**缂哄け**锛氬彧鑳界湅鍙樻洿涓婁笅鏂囷紝鏃犳硶鏌ョ湅瀹屾暣鏂囦欢鍐呭銆?

**鍚庣鏂板**锛?
- `crates/git/src/lib.rs` 鏂板锛?
  - `get_file_full_diff(repo_path, file_path)` 鈥?鐢熸垚瀹屾暣鏂囦欢 Diff锛堟墍鏈夎锛?
- `src-tauri/src/commands/workspaces.rs` 鏂板鍛戒护锛?
  - `get_workspace_file_full_diff`

**鍓嶇淇敼**锛?
- `GitDiffViewer.tsx` 鏂板鍐呭妯″紡鍒囨崲锛?
  - `Focused` 鈥?浠呭彉鏇翠笂涓嬫枃锛堥粯璁わ紝褰撳墠琛屼负锛?
  - `All Content` 鈥?鍔犺浇瀹屾暣鏂囦欢 Diff
  - 鍒囨崲鏃舵樉绀哄姞杞界姸鎬?

**鍙傝€?*锛歮ossx `contentMode` 瀹炵幇銆?

---

### Phase G4 鈥?GitHub 闆嗘垚锛堜綆浼樺厛绾э級

> 鐩爣锛氶泦鎴?GitHub Issues 鍜?PR 鍔熻兘锛屼笌 AI 瀵硅瘽鑱斿姩銆?
> 棰勪及锛?-7 涓伐浣滄棩
> 渚濊禆锛氶渶瑕?GitHub Personal Access Token 閰嶇疆鏈哄埗

#### G4.1 GitHub Issues 妯″紡

**鍓嶆彁**锛氭柊澧?GitHub API 闆嗘垚灞傘€?

**鍚庣鏂板**锛?
- `crates/github/` 鏂?crate锛堟垨鍦?`crates/services/` 涓柊澧炴ā鍧楋級锛?
  - GitHub REST/GraphQL API 瀹㈡埛绔?
  - PAT Token 閰嶇疆瀛樺偍锛堝姞瀵嗗瓨鍌ㄥ湪 SQLite 鎴栫郴缁?keychain锛?
  - `list_issues(owner, repo)` 鈥?鑾峰彇 open issues
  - `get_issue(owner, repo, number)` 鈥?鑾峰彇鍗曚釜 issue 璇︽儏

**鍓嶇鏂板**锛?
- `GitPanel.tsx` 闈㈡澘妯″紡鏂板 `issues` Tab
- `frontend/src/components/panels/git/GitIssuesView.tsx`锛?
  - Issue 鍒楄〃锛歚#{number}` + 鏍囬 + 鐩稿鏃堕棿
  - 鐐瑰嚮鎵撳紑娴忚鍣?
  - 鏄剧ず open issue 鎬绘暟
  - 鍔犺浇/绌?閿欒鐘舵€?

**鍙傝€?*锛歮ossx `useGitHubIssues.ts` + Issues 妯″紡銆?

---

#### G4.2 GitHub PRs 妯″紡

**鍚庣鏂板**锛?
- `crates/github/` 鎵╁睍锛?
  - `list_pull_requests(owner, repo)` 鈥?鑾峰彇 open PRs
  - `get_pr_diffs(owner, repo, number)` 鈥?鑾峰彇 PR Diff
  - `get_pr_comments(owner, repo, number)` 鈥?鑾峰彇 PR 璇勮

**鍓嶇鏂板**锛?
- `GitPanel.tsx` 闈㈡澘妯″紡鏂板 `prs` Tab
- `frontend/src/components/panels/git/GitPRsView.tsx`锛?
  - PR 鍒楄〃锛歚#{number}` + 鏍囬 + 浣滆€?+ Draft 鏍囪 + 鏇存柊鏃堕棿
  - 閫変腑 PR 鍒囨崲 Diff 鏌ョ湅鍣ㄦ樉绀?PR Diff
  - PR 璇︽儏鎽樿锛堟爣棰樸€佹弿杩般€佸垎鏀俊鎭級
  - 璇勮鏃堕棿绾匡紙Activity Timeline锛?
  - 鍙抽敭鑿滃崟锛歚Open on GitHub`

**鍙傝€?*锛歮ossx PRs 妯″紡 + `PullRequestSummary`銆?

---

#### G4.3 PR 鏅鸿兘瀵硅瘽锛圓I 鑱斿姩锛?

**鍓嶇鏂板**锛?
- `frontend/src/hooks/git/usePullRequestComposer.ts`锛?
  - 閫変腑 PR 鏃跺湪 AI 杈撳叆妗嗛濉笂涓嬫枃
  - Send 鎸夐挳鏍囩鍙樹负 "Ask PR"
  - 鏋勫缓鍖呭惈 PR 涓婁笅鏂囩殑瀹屾暣 prompt
  - 鍙戦€佸悗鑷姩鍒涘缓鏂?Thread/Attempt

**鍙傝€?*锛歮ossx `usePullRequestComposer.ts` + `buildPullRequestPrompt`銆?

---

#### G4.4 AI 鐢熸垚 Commit 娑堟伅

**鍚庣鍒╃敤**锛氬彲澶嶇敤宸叉湁鐨?AI 鎵ц鍣ㄥ熀纭€璁炬柦銆?

**鍓嶇淇敼**锛?
- `GitCommitBox.tsx`锛?
  - 鏂板 AI 鐢熸垚鎸夐挳锛圫parkles 鍥炬爣锛?
  - 鐐瑰嚮鍚庯細鏀堕泦 staged diff 鈫?璋冪敤 AI 鈫?濉叆 commit 娑堟伅
  - 鍔犺浇涓樉绀烘棆杞姩鐢?
  - 閿欒鐘舵€佸鐞?

---

## 瀹炴柦椤哄簭涓庝緷璧栧叧绯?

```
Phase G1锛堟牳蹇冿級
  G1.1 Pull/Fetch  鈫?鐙珛锛屽彲棣栧厛瀹炴柦
  G1.2 鍒嗘敮绠＄悊    鈫?鐙珛锛屽彲涓?G1.1 骞惰
  G1.3 鏃ュ織澧炲己    鈫?渚濊禆 G1.1锛圥ull 鍚?behind 鏁版嵁鏇村噯纭級
  G1.4 Flat/Tree   鈫?鐙珛锛屽彲涓?G1.1/G1.2 骞惰

Phase G2锛堜氦浜掞級
  G2.1 涓㈠純纭    鈫?鐙珛
  G2.2 Commit鎶樺彔  鈫?鐙珛
  G2.3 棰勮妯℃€?   鈫?鐙珛
  G2.4 澶氭枃浠堕€夋嫨  鈫?鐙珛
  G2.5 鍙抽敭鑿滃崟    鈫?渚濊禆 G2.4锛堝閫夊悗鎵归噺鎿嶄綔锛?

Phase G3锛圖iff澧炲己锛?
  G3.1 Sticky澶?   鈫?鐙珛
  G3.2 Anchor瀵艰埅  鈫?鐙珛
  G3.3 Full Diff   鈫?闇€鍚庣鏂板鍛戒护

Phase G4锛圙itHub锛?
  G4.1 Issues      鈫?闇€鏂板缓 GitHub API 闆嗘垚灞?
  G4.2 PRs         鈫?渚濊禆 G4.1 鐨?API 灞?
  G4.3 PR 鏅鸿兘瀵硅瘽 鈫?渚濊禆 G4.2
  G4.4 AI Commit   鈫?鐙珛锛堜絾寤鸿涓?G4 涓€璧峰仛锛?
```

---

## 鏂囦欢淇敼娓呭崟

### 鏂板鏂囦欢

| 鏂囦欢 | Phase | 鐢ㄩ€?|
|------|-------|------|
| `frontend/src/hooks/git/useGitBranches.ts` | G1.2 | 鍒嗘敮绠＄悊 Hook |
| `frontend/src/components/panels/git/GitBranchList.tsx` | G1.2 | 鍒嗘敮鍒楄〃缁勪欢 |
| `frontend/src/components/panels/git/GitFileTree.tsx` | G1.4 | 鐩綍鏍戣鍥剧粍浠?|
| `frontend/src/components/panels/git/GitDiscardDialog.tsx` | G2.1 | 涓㈠純纭寮圭獥 |
| `frontend/src/components/panels/git/GitDiffModal.tsx` | G2.3 | 鏂囦欢棰勮妯℃€佹 |
| `crates/github/` (鏁翠釜 crate) | G4.1 | GitHub API 闆嗘垚 |
| `frontend/src/components/panels/git/GitIssuesView.tsx` | G4.1 | Issues 鍒楄〃 |
| `frontend/src/components/panels/git/GitPRsView.tsx` | G4.2 | PR 鍒楄〃涓庡鏌?|
| `frontend/src/hooks/git/usePullRequestComposer.ts` | G4.3 | PR AI 瀵硅瘽缁勫悎 |

### 淇敼鏂囦欢

| 鏂囦欢 | Phase | 淇敼鍐呭 |
|------|-------|----------|
| `crates/git/src/lib.rs` | G1.1, G3.3 | 鏂板 pull/fetch/full-diff 鏂规硶 |
| `src-tauri/src/commands/workspaces.rs` | G1.1, G1.2, G3.3 | 鏂板 Tauri 鍛戒护 |
| `crates/api-types/src/*.rs` | G1.1 | 鏂板 PullResult 绛夌被鍨?|
| `frontend/src/lib/api.ts` | G1.1, G1.2, G3.3 | 鏂板 API 灏佽 |
| `frontend/src/hooks/git/useGitActions.ts` | G1.1 | 鏂板 pull/fetch 鎿嶄綔 |
| `frontend/src/components/panels/git/GitPanel.tsx` | G1.1-G1.4, G2.2 | 宸ュ叿鏍忋€佹ā寮?Tab |
| `frontend/src/components/panels/git/GitLogView.tsx` | G1.3 | 涓夊垎鍖?+ 鍙抽敭鑿滃崟 |
| `frontend/src/components/panels/git/GitStagingArea.tsx` | G1.4, G2.1, G2.4, G2.5 | Tree 瑙嗗浘銆佸閫夈€佸彸閿?|
| `frontend/src/components/panels/git/GitFileRow.tsx` | G2.3, G2.4 | 鍙屽嚮棰勮銆侀€変腑鐘舵€?|
| `frontend/src/components/panels/git/GitDiffViewer.tsx` | G3.1, G3.2, G3.3 | Sticky澶淬€佸鑸€丗ull Diff |
| `frontend/src/components/panels/git/GitCommitBox.tsx` | G4.4 | AI 鐢熸垚鎸夐挳 |
| `shared/types.ts` | G1.1 | 鑷姩鐢熸垚鏇存柊 |

---

## 楠屾敹鏍囧噯

### Phase G1 瀹屾垚鏍囧噯
- [ ] 鍙互鎵ц Pull/Fetch 鎿嶄綔锛屾寜閽湪鏈?behind 鎻愪氦鏃堕珮浜樉绀?
- [ ] 鍙互鏌ョ湅鎵€鏈夊垎鏀垪琛紝鍒囨崲鍒嗘敮锛屽垱寤烘柊鍒嗘敮
- [ ] Log 瑙嗗浘鎸?To Push / To Pull / Recent 涓夊尯鍒嗗垪
- [ ] Log 鎻愪氦琛屾敮鎸佸彸閿?Copy SHA / Open on GitHub
- [ ] 鏂囦欢鍒楄〃鏀寔 Flat/Tree 涓ょ瑙嗗浘妯″紡鍒囨崲

### Phase G2 瀹屾垚鏍囧噯
- [ ] Revert/Discard 鎿嶄綔寮瑰嚭纭瀵硅瘽妗?
- [ ] Commit 鍖哄煙鍙互鎶樺彔/灞曞紑
- [ ] 鍙屽嚮鏂囦欢琛屾墦寮€鍏ㄥ睆 Diff 棰勮
- [ ] 鏀寔 Ctrl+Click 澶氶€夊拰 Shift+Click 鑼冨洿閫?
- [ ] 鏂囦欢鍒楄〃鏀寔鍙抽敭涓婁笅鏂囪彍鍗?

### Phase G3 瀹屾垚鏍囧噯
- [ ] 婊氬姩 Diff 鏃堕《閮ㄥ浐瀹氭樉绀哄綋鍓嶆枃浠惰矾寰?
- [ ] 鍙€氳繃涓?涓嬫寜閽湪鍙樻洿浣嶇疆涔嬮棿璺宠浆
- [ ] 鍙垏鎹?Focused/All Content 涓ょ Diff 鍐呭妯″紡

### Phase G4 瀹屾垚鏍囧噯
- [ ] 鍙煡鐪?GitHub Issues 鍒楄〃骞舵墦寮€閾炬帴
- [ ] 鍙煡鐪?GitHub PRs 鍒楄〃銆丳R Diff 鍜岃瘎璁?
- [ ] 閫変腑 PR 鍙Е鍙?AI 瀵硅瘽骞舵敞鍏?PR 涓婁笅鏂?
- [ ] 鍙€氳繃 AI 鑷姩鐢熸垚 Commit 娑堟伅
