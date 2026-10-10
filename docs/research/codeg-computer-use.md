# codeg Computer Use 娣卞叆鐮旂┒

鐮旂┒鏃ユ湡锛?026-10-08  
鐮旂┒瀵硅薄锛歚https://github.com/xintaofei/codeg`锛宍main` 涓?`origin/main` 鍚屾锛孒EAD `592131c72e2a05478e7f8398a91cb653c8e3996f`锛坄v0.34.0`锛?026-10-07锛夈€傜爺绌惰繃绋嬩腑鏈敼鍔?codeg 浠撳簱銆?
鏈枃浠ヨ commit 鐨勬簮鐮佷负浜嬪疄渚濇嵁銆傛湯灏锯€淰ibeX 璁捐鎺ㄦ柇鈥濇槸杩佺Щ寤鸿锛屼笉浠ｈ〃 codeg 宸茬粡閲囩敤 VibeX 鐨勬彃浠舵灦鏋勩€?
## 姒傝

codeg computer use 灏嗙敤鎴锋闈笂鐨勫師鐢熷簲鐢ㄧ獥鍙ｄ綔涓哄彲鏄惧紡鎺堟潈鐨勭洰鏍囷紝鍚?agent 鎻愪緵搴旂敤/绐楀彛鍙戠幇銆乤ccessibility tree銆佹埅鍥俱€佺姸鎬侀獙璇佷互鍙婂彈绾︽潫鐨勮緭鍏ュ姩浣溿€傚畠鍖哄垎鈥滆鈥濅笌鈥滄帶鍒垛€濓紝鏀寔绐楀彛銆佸簲鐢ㄣ€佹暣涓睆骞曚笁绫绘巿鏉冭寖鍥达紱榛樿杈撳叆鍦ㄥ悗鍙版姇閫掞紝鍓嶅彴鎶曢€掋€佸惎鍔ㄥ簲鐢ㄣ€佺獥鍙ｇЩ鍔ㄣ€佸壀璐存澘銆佸睆骞曞垎浜瓑鏇村ぇ褰卞搷闈㈣兘鍔涘垎鍒彈璁剧疆鎺у埗銆?
璁捐涓婄殑鍏抽敭杈圭晫鏄細agent 宸ュ叿灞備笉鐩存帴璋冪敤 CUA driver銆侫CP/MCP 宸ュ叿杩涘叆 `ComputerService`锛屾湇鍔″厛妫€鏌?grant銆乼arget銆佷唬闄呫€佺瓥鐣ュ拰 Stop 鐘舵€侊紝鍐嶉€氳繃灏侀棴鐗堟湰鍖栧崗璁姹傜嫭绔?helper锛沨elper 鍐嶅皢鏈夐檺鐨勬搷浣滆浆鎹负鍥哄畾 driver 璋冪敤锛屽苟鍦ㄦ墽琛岀偣閲嶉獙绐楀彛韬唤銆乻ecret field銆乻ession 涓庡揩鐓х姸鎬併€俶acOS 鍙︿互鐙珛绛惧悕 helper 浣滀负 TCC 鏉冮檺涓讳綋銆傝璁捐鎻愬崌浜嗗伐鍏烽潰绾︽潫锛屼絾涓嶈兘琚〃杩版垚閫氱敤鎭舵剰浠ｇ爜娌欑锛沇indows/X11 涓婁富绋嬪簭涓?helper 閫氬父澶勪簬鍚屼竴鐢ㄦ埛鏉冮檺杈圭晫銆?
## 绔埌绔灦鏋?
```text
鐢ㄦ埛 Computer Use picker / Settings
  鈹斺攢 Tauri invoke 鎴?HTTP server API
       鈹斺攢 ComputerService: 绛栫暐銆乀argetTable 鎺堟潈銆乬eneration銆丼top銆佹椿鍔ㄤ簨浠?            鈹溾攢 ACP listener 鐨?computer_* tools 鈹€鈹€> ComputerToolAccess
            鈹斺攢 LocalBackend 鈹€鈹€> 绉佹湁 framed JSON channel
                                  鈹斺攢 codeg-computer-helper
                                       鈹溾攢 OS window/accessibility/screenshot/input
                                       鈹斺攢 stdio JSON-RPC 鈹€鈹€> pinned cua-driver
```

鏈嶅姟鍚姩鏃跺垱寤?`LocalBackend`銆乣TargetTable`銆侀┍鍔ㄧ鐞嗗櫒锛涙闈?host 鍙﹀垱寤?Stop shortcut銆侀《閮?indicator 涓庢搷浣?marker銆傞厤缃彉鍖栦細绔嬪嵆鏇存柊绛栫暐锛屽叧闂兘鍔涙垨鎵╁ぇ blocklist 浼氱粨鏉熷凡琚姝㈢殑 grant锛涘彟鏈夎繃鏈?sweeper 娓呯悊闂茬疆鎺堟潈銆俒computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L574) [computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L636)

ACP/MCP listener 鐨勯€傞厤鍣ㄥ彧鎶婃柟娉曡浆浜ょ粰 `ComputerService`锛屼笉瀛樺湪 MCP 涓撳睘鎺堟潈鎹峰緞锛涘洜姝ゅ悓涓€ grant 妫€鏌ュ拰娲诲姩璁板綍瑕嗙洊宸ュ叿璋冪敤銆俒computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L2253) 宸ュ叿灞傚皢鎷掔粷缂栫爜鎴愭湁 `error` 涓?`note` 鐨勭粨鏋滃€艰€岄潪 RPC 浼犺緭閿欒锛岃 agent 鑳藉垽鏂敤鎴峰姩浣溿€侀噸璇绘垨鍋滄閲嶈瘯銆俒computer_tools.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/computer_tools.rs#L50)

涓荤▼搴忎笌 helper 浣跨敤闀垮害鍓嶇紑 JSON frame锛沺rotocol version 涓?14锛宧elper 棣栧厛鍙戦€?Ready銆傚崗璁槸灏侀棴 `HelperOp` 鏋氫妇锛涗緥濡?Act 鎼哄甫灏侀棴 `WindowAction`锛屼笉浼?driver tool 鍚嶇О銆傛敞閲婃槑纭鏄?driver 鐨勫叾浠栬兘鍔涳紙鍖呮嫭鍚姩/鏉€杩涚▼銆佹敼鑷韩閰嶇疆銆佸洖鏀捐緭鍏ワ級涓嶇粡璇ュ崗璁毚闇层€俒protocol.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/protocol.rs#L1) [protocol.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/protocol.rs#L46) [protocol.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/protocol.rs#L73) [protocol.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/protocol.rs#L278) Driver side 浣跨敤 MCP JSON-RPC `tools/call`锛屽浐瀹氬崗璁増鏈?`2025-06-18`锛岄檺鍒惰闀垮害銆佹瘡娆″崟璋冪敤涓茶鍖栧苟璁剧疆瓒呮椂銆俒mcp.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/helper/mcp.rs#L1) [mcp.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/helper/mcp.rs#L38)

## 鍔熻兘涓庡伐鍏烽潰

瀹屾暣鍏紑宸ュ叿鍚嶅畾涔変簬 `src-tauri/src/acp/delegation/tool_schema.json`銆係chema 鐨勯暱鎻忚堪鏈韩涔熸槸瀹夊叏濂戠害锛氭槑纭鏄庤皝鑳芥巿鏉冦€佷綍鏃堕渶瑕侀噸璇汇€佹瘡绫?refusal 鏄惁鍙噸璇曪紝浠ュ強涓嶅緱鎶婂睆骞曞唴瀹瑰綋浣滄寚浠ゃ€?
| 鑳藉姏 | 宸ュ叿 | 琛屼负/杈圭晫 |
|---|---|---|
| 鍙戠幇 | `computer_list_apps`, `computer_list_windows` | 搴旂敤鍒楄〃鎻愪緵 key/PID锛涚獥鍙ｅ垪琛ㄧ粰鍑?agent 鍙鐩爣鍜屽綋鍓嶈緭鍏ョ瓥鐣ャ€傛湭鎺堟潈绐楀彛涓嶆硠闇叉爣棰樸€?|
| 瑙傚療 | `computer_screenshot`, `computer_snapshot` | 鎴浘鎼哄甫灏哄銆佹闈?bounds 涓?generation锛泃ree 杩斿洖鍙搷浣?ref銆佽鑹层€佹爣绛惧拰鍊硷紱secret value 涓嶅洖浼犮€備紭鍏?tree锛屾埅鍥剧敤浜庡浘鍍忓竷灞€/canvas銆?|
| 楠岃瘉 | `computer_verify` | 瀵?bounds銆佽鑹?鏍囩銆乪nabled銆乻elected 绛夎皳璇嶈疆璇紝杩斿洖 satisfied/unsatisfied/unknown锛屼笉杩斿洖閲囨牱鍒扮殑鍊笺€?|
| 杈撳叆 | `computer_click`, `computer_drag`, `computer_scroll`, `computer_type`, `computer_press_key`, `computer_hold_key`, `computer_set_value` | ref/point 蹇呴』鏉ヨ嚜鐩爣鐨勬渶鏂?generation锛涙敮鎸佸悗鍙伴粯璁ゆ姇閫掞紱鍔ㄤ綔鍙湪 control grant 涓嬪厑璁搞€?|
| 绐楀彛/搴旂敤 | `computer_restore`, `computer_invoke_menu`, `computer_launch_app`, `computer_set_window_frame` | 鑿滃崟鍜?app shortcuts 闇€瑕?app 鎴?screen scope锛涘惎鍔?绉诲姩闇€鐢ㄦ埛鍦ㄨ缃腑鎵撳紑锛況estore 鐨?Linux 璇箟鍙兘浼氱疆鍓嶃€?|
| 鍓创鏉?| `computer_clipboard_read`, `computer_clipboard_write` | 闇€鍗曠嫭鍚敤銆俽ead 鍙洖璇?agent 鍐欏叆鐨勬枃鏈垨浠庝粛鎺堟潈绐楀彛澶嶅埗鐨勫唴瀹癸紝涓嶈鐢ㄦ埛鑷澶嶅埗鐨勭瀵嗗唴瀹广€?|

Schema 璇佹嵁锛氬伐鍏锋€昏〃 [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L660)锛屾埅鍥惧強 generation 鎻忚堪 [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L703)锛宻napshot/ref [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L724)锛寁erify [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L759)锛宑lick 鎶曢€掑拰 refusal 璇箟 [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L873)锛宑lipboard 闅旂璇箟 [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L1367)銆?
### 閿欒璇箟

涓昏閿欒鐮佸強寤鸿鎭㈠鍔ㄤ綔锛?
| 閿欒 | 鍚箟涓庢仮澶?|
|---|---|
| `computer_unavailable` | 鏈惎鐢ㄣ€佸綋鍓嶆棤妗岄潰鎴栬兘鍔涗笉鍙敤锛涗笉鏄洸鐩噸璇曚俊鍙枫€?|
| `computer_grant_required` / `computer_control_required` | 璇锋眰鐩爣灏氭湭鎺堟潈/鍙湁 read锛涚敱鐢ㄦ埛鍒嗕韩鎴栧崌绾ф巿鏉冦€?|
| `computer_no_such_target` / `computer_blocked` | 鐩爣鏃犳晥鎴栨案涓嶅厑璁稿垎浜紱鍋滄骞堕噸鏂板彂鐜版垨閫夊叾浠栫洰鏍囥€?|
| `computer_permission_missing` | helper 缂?OS 鏉冮檺锛涚敤鎴峰湪绯荤粺璁剧疆澶勭悊銆?|
| `computer_stale_ref` | generation 宸茶繃鏈燂紱閲嶆柊 snapshot/screenshot 鍚庡啀瀹氫綅銆?|
| `computer_out_of_target` / `computer_occluded` | 鍧愭爣瓒婄晫鎴栫洰鏍囧綋鍓嶄笉鍙畨鍏ㄦ姇閫掞紱閲嶆柊瑙傚療/鎭㈠绐楀彛銆?|
| `computer_background_unavailable` / `computer_foreground_not_allowed` | 搴旂敤涓嶆敮鎸佸悗鍙拌緭鍏ワ紝鎴栫敤鎴蜂笉鍏佽鍓嶅彴锛涙槸鍚﹀墠鍙扮敱璁剧疆鍐冲畾銆?|
| `computer_action_failed` / `computer_read_failed` | driver 鎴栨帶浠舵搷浣滃け璐ワ紱鏍规嵁 note 澶勭悊鍏蜂綋鍘熷洜銆?|
| `computer_paused` | 閿佸睆鎴栧叾浠?session active锛涚瓑寰呯敤鎴锋仮澶嶃€?|
| `computer_stopped` | 鐢ㄦ埛 Stop 宸叉挙閿€鎵€鏈夊垎浜苟涓柇鍔ㄤ綔锛涗笉寰楄嚜鍔ㄩ噸璇曪紝椤荤敤鎴烽噸鏂板垎浜€?|

鏋氫妇娉ㄩ噴鍙婃仮澶嶆帾杈炶 [computer_tools.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/computer_tools.rs#L50)銆傝繖灏?agent 鐨勯敊璇鐞嗗仛鎴愬彲鎵ц鍗忚锛岄伩鍏嶆ā鍨嬫妸鎵€鏈夊け璐ラ兘褰掍负鐬椂鏁呴殰銆?
## 鎺堟潈銆侀殣绉佷笌瀹夊叏

鎺堟潈鐢?`TargetTable` 涓殑 grant 椹卞姩锛岄粯璁や笉鍥犵獥鍙ｄ綅浜庡墠鍙般€乤gent 鍚姩搴旂敤鎴栫洰鏍囧凡鍑虹幇鍦ㄥ垪琛ㄤ腑鑰岃嚜鍔ㄦ巿鏉冦€侴rant 绾у埆涓?`read` / `control`锛宻cope 涓哄崟绐楀彛銆佸簲鐢ㄦ垨鏁翠釜灞忓箷锛涘悗涓よ€呭悜鍏惰鐩栫獥鍙ｇ户鎵挎巿鏉冦€侴rant 鏈?idle TTL锛堝彲閰嶇疆鏃犳湡闄愶級銆乪poch銆佽娆℃暟銆乧apture/snapshot marks锛涙瘡娆″垎浜姸鎬佸彉鍖栨帹杩?epoch锛屼娇鎾ら攢鍓?generation 鏃犳硶鐢ㄤ簬閲嶆巿鏉冨悗鐨勬搷浣溿€俒agent.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/agent.rs#L37) [agent.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/agent.rs#L96) [agent.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/agent.rs#L142) [targets.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/targets.rs#L80)

Window identity 鍖呭惈 PID銆佽繘绋嬪惎鍔ㄦ椂闂淬€佸簲鐢?key锛屼互鍙婄獥鍙ｅ唴瀹圭敱鍙︿竴杩涚▼缁樺埗鏃剁殑 content process run锛涗粎 PID 涓嶈冻浠ヨ法閲嶅惎澶嶇敤 grant銆傜獥鍙ｆ秷澶变細淇濈暀 grant-less tombstone锛屼娇鏃?target 杩斿洖鈥滄湭鍒嗕韩鈥濊€屼笉鏄鏈巿鏉冭皟鐢ㄥ尯鍒嗘浘瀛樺湪鐨勭獥鍙ｃ€備笉鍙垎浜洰鏍囧寘鎷?codeg 鑷韩銆侀粯璁?鐢ㄦ埛 blocklist 浠ュ強韬唤涓嶅彲鍒ゅ畾鐨勫簲鐢ㄣ€俒agent.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/agent.rs#L149) [targets.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/targets.rs#L90) [targets.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/targets.rs#L116)

Read 鍜屽姩浣滈兘鐢辨湇鍔＄閲嶆柊鍒ゅ畾锛屽墠绔?UI 涓嶈兘鏋勬垚鎺堟潈浜嬪疄婧愩€俁ead grant 涓嶈冻浠ヨ緭鍏ワ紱window scope 鐨勫揩鎹烽敭闄愬埗浜庣獥鍙ｈ嚜韬紝鑿滃崟绛?app 绾у壇浣滅敤瑕佹眰 app scope锛泂creen scope 涔熶笉鍏佽閿佸睆銆佹敞閿€绛?session 绾у揩鎹烽敭銆傛埅鍥惧潗鏍囩┖闂翠笌妗岄潰 bounds 鍒嗗紑绠＄悊锛宺ef/point 蹇呴』甯︽渶鏂?generation銆俬elper 鐨?`SnapshotBook` 鏍￠獙蹇収 id銆乪lement index 鍜?secret flag锛涜緭鍏ュ墠閲嶇湅绐楀彛 owner/content process/session/Stop锛宒river 瀵瑰悗鍙拌緭鍏ュ啀纭鎶曢€掔洰鏍囥€俒computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L1385) [computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L1519) [computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L1659) [act.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/helper/act.rs#L1) [protocol.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/protocol.rs#L150)

鍏朵粬闅愮鎺柦锛歴ecret/password tree 鍊间笉杈撳嚭涓斾笉鍏佽杈撳叆锛沜apture 涓?tree 鍐呭浣滀负涓嶅彲淇℃暟鎹紝schema 鏄庣‘瑕佹眰涓嶅緱閬典粠鍏朵腑鎸囦护锛涘壀璐存澘鏈夌嫭绔嬪紑鍏冲拰鏉ユ簮杩借釜锛涘睆骞曟埅鍥句細閬斀涓嶅彲鍒嗕韩搴旂敤銆乧odeg 绐楀彛鍙婄郴缁熸闈㈣楗板尯鍩燂紱Stop 鍚屾鎾ら攢鎵€鏈?grant銆佸彇娑?in-flight 鎿嶄綔骞惰 helper 蹇界暐 Stop 涔嬪墠鎺掑叆鐨勫姩浣溿€俒agent.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/agent.rs#L135) [tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L703) [computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L36)

### 鏉冮檺杈圭晫闄愬埗

macOS 鐨?TCC Accessibility / Screen Recording 鏉冮檺鎺堜簣鐙珛绛惧悕鐨?`codeg-computer-helper`锛涗富 codeg 涓嶆寔鏈夎繖浜?entitlements锛屼篃涓嶈皟鐢ㄥ彈淇濇姢 API銆俬elper 楠岃瘉 peer 鐨勭鍚嶄笌 launch requirement锛沝river 鐨勮矾寰?鐗堟湰涓嶈兘鍗曠敱璋冪敤鑰呮彁渚涳紝helper 鎸夌紪璇?pin 楠岃瘉杩愯闀滃儚銆傚彂甯冩祦绋嬪皢 helper 鍗曠嫭绛惧叆 `Contents/Helpers`锛屽苟妫€鏌?app/MCP/helper entitlement 涓庣鍚嶅叧绯汇€俒local.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/local.rs) [build.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/build.rs) [release.yml](C:/Users/18190/Documents/projects/codeg/.github/workflows/release.yml)

璇ラ殧绂诲湪 macOS TCC 涓婃湁瀹為檯鐨勬潈闄愪富浣撴剰涔夛紝浣嗕笉绛変簬瀹屾暣 sandbox銆俢odeg 婧愮爜娉ㄩ噴鎵胯 Windows/X11 涓?agent shell 涓庝富绋嬪簭鍙兘鍚屾潈闄愶紝helper gate 绾︽潫鐨勬槸 computer tool surface锛涜嫢鍚屾潈闄愪换鎰?shell 鍙洿鎺ユ帶鍒舵闈紝涓嶈兘澹扮О OS 灞傚己鍒堕檺鍒?shell銆俒computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L123)

## UI 涓庣姸鎬佸弽棣?
绐楀彛 picker 鎸?app 鍒嗙粍锛屾彁渚涙瘡涓獥鍙ｇ缉鐣ュ浘銆佹爣棰樸€佸彲瑙佹€ф爣璁板拰涓夋€佹巿鏉冩帶浠讹紙none/read/control锛夛紱鏀寔鎵归噺绐楀彛鎺堟潈銆佹暣涓?app 鎺堟潈浠ュ強鎸夎缃彁渚涚殑鏁村睆鎺堟潈銆傛暣 app 鍒嗕韩瑕嗙洊鍏跺悗鏂板紑鐨勭獥鍙ｅ強 app 鑿滃崟锛涙暣灞忓垎浜鐩栧悗缁獥鍙ｃ€傚缁ф壙 app/screen 鎺堟潈鐨勭獥鍙ｆ樉绀烘潵婧愶紝鍗曠獥鎺у埗閿佸畾銆備笉鍙垎浜獥鍙ｅ湪鎶樺彔鍖烘樉绀哄師鍥犱笖涓嶅彇缂╃暐鍥俱€俒computer-window-picker.tsx](C:/Users/18190/Documents/projects/codeg/src/components/computer/computer-window-picker.tsx#L3) [computer-window-picker.tsx](C:/Users/18190/Documents/projects/codeg/src/components/computer/computer-window-picker.tsx#L105) [computer-window-picker.tsx](C:/Users/18190/Documents/projects/codeg/src/components/computer/computer-window-picker.tsx#L160)

鐘舵€佹爮 Computer Use 闈㈡澘姹囨€诲叡浜璞°€佹潈闄愩€乥ackend/helper/driver 鍜岃繎鏈熷姩浣滐紝骞舵彁渚?Stop锛涚嫭绔嬬疆椤?indicator 鏄剧ず鍏变韩鑼冨洿銆丼top 涓庡揩鎹烽敭锛屽伐浣滃尯绐楀彛闅愯棌鏃朵粛鍙锛沵arker 鍦ㄥ疄闄呭姩浣滃潗鏍囨彁渚涚煭鏆傝瑙夊弽棣堛€係ettings 鎶婃€诲紑鍏炽€乨river install/remove銆乵acOS 鏉冮檺寮曞銆乬rant TTL銆侀粯璁?delivery銆乫oreground permission銆乤pp launch/window frame銆乧lipboard銆乻creen share銆乥locklist銆丼top shortcut 涓?indicator 閰嶇疆闆嗕腑璧锋潵銆俒computer-use-settings.tsx](C:/Users/18190/Documents/projects/codeg/src/components/settings/computer-use-settings.tsx#L3) [computer-settings.tsx](C:/Users/18190/Documents/projects/codeg/src/components/settings/computer-settings.tsx)

Picker 鐨勭缉鐣ュ浘鏄湰鍦?helper 鎸夌獥鍙ｉ€愪釜鎹曡幏锛岄潰鍚戠敤鎴锋樉绀哄畬鏁寸獥鍙ｏ紱agent 鏈幏鎺堟潈鏃舵嬁涓嶅埌鏍囬鎴栫缉鐣ュ浘銆俶acOS Screen Recording 涓嶅彲鐢ㄦ椂 picker 灞曠ず淇璺緞锛岄噸鏂拌幏寰楁潈闄愬悗鍒锋柊绐楀彛涓庡浘鍍忋€俒computer-window-picker.tsx](C:/Users/18190/Documents/projects/codeg/src/components/computer/computer-window-picker.tsx#L11)

## 浠ｇ爜妯″潡绱㈠紩

| 灞?| 涓昏妯″潡 | 璐ｄ换 |
|---|---|---|
| Agent 鍗忚 | `src-tauri/src/acp/delegation/tool_schema.json`, `acp/computer_tools.rs` | tool names/schema銆佺粨鏋勫寲 outcome/refusal銆乴istener access trait銆?|
| 鏈嶅姟涓?IPC | `src-tauri/src/commands/computer.rs`, `commands/computer_tools.rs`, `web/handlers/computer.rs`, `web/router.rs` | 杩愯鏈嶅姟銆佺獥鍙ｆ巿鏉冨懡浠ゃ€乀auri/HTTP 鎺ュ叆銆佷簨浠躲€丼top 涓庨厤缃€?|
| 鎺堟潈/鐩爣 | `src-tauri/src/computer/agent.rs`, `targets.rs` | grant scope/level銆乮dentity銆乥locklist銆乀TL銆乪poch/generation銆侀槻 stale銆?|
| Backend/helper | `computer/backend.rs`, `local.rs`, `protocol.rs`, `helper/*.rs`, `bin/codeg_computer_helper.rs` | helper 鐢熷懡鍛ㄦ湡銆佺増鏈崗璁€丱S access銆乨river 绠＄悊涓庡浐瀹氳皟鐢ㄣ€?|
| 鍓嶇 API/state | `src/lib/computer/computer-api.ts`, `types.ts`, `computer-store.ts`, `use-computer-status.ts` | 缁熶竴 invoke/HTTP API銆佽法缁勪欢鐘舵€佸強浜嬩欢鍚屾銆?|
| 鍓嶇 UI | `src/components/computer/*`, `src/components/settings/computer-use-settings.tsx`, `computer-settings.tsx`, `src/components/layout/status-bar-computer.tsx`, `src/app/computer-indicator/page.tsx` | picker銆乮ndicator銆乵arker銆乻ettings銆佺姸鎬佹爮鍏ュ彛銆?|

鏈嶅姟鍏ュ彛涓?state composition锛歔computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L574)锛汚CP 杞彂锛歔computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L2264)锛汿auri commands 浠?[computer.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/commands/computer.rs#L2385) 璧凤紱鍓嶇 transport API锛歔computer-api.ts](C:/Users/18190/Documents/projects/codeg/src/lib/computer/computer-api.ts)锛泂tore锛歔computer-store.ts](C:/Users/18190/Documents/projects/codeg/src/lib/computer/computer-store.ts)銆?
## 骞冲彴銆佽繍琛屾ā寮忎笌鍙戝竷

- **macOS**锛歨elper 鐙珛鎸佹湁 Screen Recording 涓?Accessibility 鏉冮檺锛涙敮鎸佸師鐢?AX tree/menu銆傚墠鍙?delivery 鍙墽琛屽悗鍒囧洖鍘熷簲鐢紱restore 灏介噺涓嶆敼鍙樼劍鐐广€俬elper 蹇呴』婊¤冻绛惧悕涓?launch requirement銆?- **Windows**锛氫互绐楀彛/Accessibility API 鍜?helper-driver 鎺у埗锛沘pp menu 涓嶆槸鎸夋爣棰樿皟鐢紝鑰屾槸鍏?snapshot 鍐嶆寜 ref 鐐瑰嚮銆傚墠鍙板姩浣滃彲鎭㈠姝ゅ墠绐楀彛銆?- **X11/Linux**锛氬悗鍙拌緭鍏ョ敱 driver 鑳藉姏鍐冲畾锛涘墠鍙版搷浣?restore 鍙兘浣跨獥鍙ｇ湡姝ｇ疆鍓嶏紝鏃犳硶淇濊瘉鍒囧洖銆俉ayland 涓?minimized/foreground/鐗╃悊 modifier 鐘舵€佸瓨鍦ㄤ笉鍙娴嬫儏鍐碉紝鍥犳闇€鎷掔粷閮ㄥ垎鍓嶅彴鍔ㄤ綔銆俿creen share 鐩墠鍙湪鍙楁敮鎸佺殑骞冲彴/璁剧疆缁勫悎鎻愪緵銆?- **Server mode**锛氶粯璁ゆ棤妗岄潰涓斾笉 advertise computer tool group锛涙樉寮忓惎鐢?`CODEG_COMPUTER_USE=1` 鍚庡彧鑳芥帶鍒?server 鎵€鍦ㄦ闈€傚伐鍏疯繑鍥?`computer_unavailable`锛岃€岄潪浼€犵┖妗岄潰鎴愬姛銆?
骞冲彴琛屼负鍜?server tool discovery锛歔tool_schema.json](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/delegation/tool_schema.json#L660) [computer_tools.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/acp/computer_tools.rs#L110)锛沝river pin銆乭elper packaging銆佺鍚嶄笌鍙戝竷楠岃瘉锛歔driver.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/driver.rs) [build.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/build.rs) [tauri.conf.json](C:/Users/18190/Documents/projects/codeg/src-tauri/tauri.conf.json) [release.yml](C:/Users/18190/Documents/projects/codeg/.github/workflows/release.yml)銆傝繍琛屾椂涓嬭浇/瀹夎浠呮帴鍙?pinned driver release锛岀粡 hash/绛惧悕鎴栭暅鍍忚姹傞獙璇侊紱鍗曟鎹熷潖鍙竻缂撳瓨閲嶄笅锛宧elper 宕╂簝鍚庣殑 action 涓嶇洸鐩噸鏀句互鍏嶉噸澶嶅壇浣滅敤銆俒local.rs](C:/Users/18190/Documents/projects/codeg/src-tauri/src/computer/local.rs)

## 娴嬭瘯瑕嗙洊

Rust 娴嬭瘯闆嗕腑鍦?`src-tauri/src/computer/{agent,targets,protocol,local,backend,helper/*}.rs` 涓?`src-tauri/src/acp/computer_tools.rs`锛岃鐩?grant/expiry/blocklist/identity銆乻chema/outcome/refusal銆乸rotocol framing銆乻napshot/ref銆佺瀵嗗瓧娈点€佹寜閿瓥鐣ャ€丼top 鍜岄敊璇仮澶嶃€傚墠绔湁 `src/lib/computer/*.test.ts`銆乣src/components/computer/*.test.tsx`銆乣src/components/settings/computer-use-settings.test.tsx` 涓庣姸鎬佹爮娴嬭瘯锛岃鐩?API/store/UI 鐘舵€併€傚彂甯?workflow 鍋?macOS helper codesign銆乪ntitlement 涓?bundle layout 妫€鏌ャ€?
鐮旂┒鏃舵湭杩愯娴嬭瘯锛涗笂杩拌鐩栨槸浠庝粨搴撴祴璇曟枃浠朵笌 CI workflow 鐨勯潤鎬佹鏌ユ墍寰楋紝涓嶈〃绀烘湰鐮旂┒楠岃瘉杩囨墍鏈?OS 妗岄潰琛屼负銆傚钩鍙伴┍鍔ㄥ姛鑳戒粛闇€瑕佸搴?OS 鐨勬墜宸?E2E 楠岃瘉銆?
## 瀵?VibeX computer use 鎻掍欢 spec 鐨勮璁℃帹鏂?
浠ヤ笅鏄粨鍚?VibeX 褰撳墠鎻掍欢绯荤粺鐨勫缓璁紝闇€鍦ㄦ寮?spec 涓綔涓?VibeX 闇€姹傚喅绛栧啓娓呮锛岃€屼笉鏄収鎼?codeg 鐨勮繘绋嬫灦鏋勶細

1. **浜у搧鑳藉姏鐢辨彃浠惰础鐚紝妗岄潰鏉冨▉鐢?Host 鎸佹湁銆?* Plugin 閫氳繃 SDK 澹版槑 UI銆侀厤缃€乧ommands銆乵anaged MCP/runtime锛涙墍鏈?OS capture/input 閮借皟鐢?Host 鎻愪緵涓旀湁鎺堟潈鏍￠獙鐨?API銆傞伒寰?full-trust plugin 妯″瀷骞朵笉鎰忓懗鐫€鎻掍欢鍙互缁曡繃 Host 鐨勬巿鏉?seam銆?2. **鎷嗗垎 capability 涓?scope銆?* 鑷冲皯鍖哄垎 read/control 浠ュ強 window/app/screen scope锛涙彃浠?config 璁板綍鐢ㄦ埛鍋忓ソ锛屼笉浣滀负瀹炴椂 grant 鐪熺浉婧愩€傚嵆鏃?grants銆乪poch銆乪xpiry銆佸綋鍓?target 韬唤涓?Stop 鐘舵€佺敱 Host runtime 绠＄悊銆?3. **MCP 鍙槸鍏ュ彛銆?* MCP tool銆佹彃浠?UI銆佸揩鎹峰懡浠ょ瓑鍏ュ彛搴旀眹鍏ュ悓涓€鎺堟潈鏈嶅姟锛涗笉鍥犺皟鐢ㄦ潵鑷彃浠?runtime 鑰岄殣寮忚幏寰楁闈㈡潈闄愩€傛嫆缁濆簲杩斿洖绋冲畾 error code銆佸彲鎭㈠璇存槑銆乺etryability 鍜岀敤鎴锋墍闇€鍔ㄤ綔銆?4. **鍔ㄤ綔闇€缁戝畾瑙傚療浠ｉ檯銆?* 姣忔 snapshot/capture 閮界粰 generation锛涘厓绱?ref 鍜屽潗鏍囧姩浣滃繀椤诲紩鐢ㄥ綋鍓嶇洰鏍囨渶鏂?generation銆傛挙閿€/閲嶆柊鍒嗕韩銆佺獥鍙?杩涚▼鍙樺寲鍜屾柊瑙傚療閮戒娇鏃у紩鐢ㄥけ鏁堬紱鍧愭爣涓嶅緱娣风敤鎴浘鍍忕礌涓庢闈㈠崟浣嶃€?5. **鏀舵暃宸ュ叿闈€?* 浠ユ竻鏅扮殑 list/read/verify/act/clipboard/app-lifecycle API 寤虹珛鏄惧紡 allowlist锛沘dapter 涓嶅悜鎻掍欢/agent 杞彂浠绘剰 driver tool name銆乻hell 鎴栧綍鍒跺洖鏀惧叆鍙ｃ€?6. **鏈€灏忓寲瑙傚療涓庡啓鍏ャ€?* 榛樿鍚庡彴杈撳叆锛沠oreground銆佸惎鍔ㄥ簲鐢ㄣ€佺Щ鍔ㄧ獥鍙ｃ€乧lipboard銆乻creen scope 鍗曠嫭璁惧畾锛泂ecret fields 涓嶈/涓嶅啓锛涘壀璐存澘缁存姢鏉ユ簮/鎵€鏈夋潈鑰岄潪鐩存帴璇荤郴缁熷綋鍓嶅€笺€傛墍鏈夌獥鍙ｅ唴瀹逛綔涓轰笉鍙俊杈撳叆銆?7. **鍙鎺у埗涓庣揣鎬ュ仠姝€?* 鎻愪緵鍙寔缁湅鍒扮殑鍏变韩鐘舵€併€佹瘡鐩爣 scope/level銆佸姩浣滄椿鍔ㄨ褰曘€佷竴閿?Stop 涓庡彲閰嶇疆鍏ㄥ眬蹇嵎閿€係top 瑕佸師瀛愬湴闃绘鎺掗槦鍔ㄤ綔銆佹挙閿€鎺堟潈骞惰姹傛樉寮忛噸鏂板垎浜€?8. **鎻掍欢鐢熷懡鍛ㄦ湡涓庤瘖鏂敱 Host 缁熶竴绠＄悊銆?* plugin runtime 瀹夎/鍚姩/鍋滄銆佹潈闄愯瘖鏂€乨river/helper 鍋ュ悍涓庡钩鍙版敮鎸佺姸鎬佺粡 plugin contributions銆乨iagnostics 鍜?managed runtime 琛ㄨ揪锛涢渶瑕佹洿鏂板崗璁椂閲囩敤鐗堟湰鍗忓晢/鎷掔粷涓嶅吋瀹癸紝涓嶉潤榛橀檷绾ф潈闄愩€?9. **鎶婂钩鍙颁繚璇佸垎灞傞檲杩般€?* macOS TCC/helper 绛惧悕銆乄indows desktop APIs銆乆11 涓?Wayland 鐨勮兘鍔涗笌鐒︾偣鍓綔鐢ㄤ笉鍚屻€係pec 搴斿畾涔夋敮鎸佺煩闃靛強瀹夊叏淇濊瘉绛夌骇锛岄伩鍏嶆妸 app-level policy 鎻忚堪鎴?OS sandbox銆?10. **娴嬭瘯璁捐楠岃瘉閾捐矾鑰岄潪閲嶅瀹炵幇銆?* 鏍稿績娴嬭瘯瑕嗙洊 authorization matrix銆乻tale generation銆丼top race銆乻ecret field銆乧lipboard provenance銆佹嫆缁濋噸璇曡涔夈€乭elper protocol mismatch銆乨uplicate action 闃叉姢锛涙彃浠?UI 娴嬭瘯鍙獙璇佺敤鎴峰彲瑙佹巿鏉冪姸鎬佷笌鏁呴殰鎭㈠銆?
VibeX 鎻掍欢绯荤粺浜嬪疄鍩虹嚎璇蜂互浠撳簱 ADR 涓哄噯锛歱roduct-centric plugin/缁熶竴 contents 涓?config 绛夐厤缃湡鐩告簮瑙?ADR-0043/0046/0047/0048/0051/0066/0067/0069锛沠ull-trust 涓?Host 绠＄悊 runtime/contributions 鐨勭害鏉熻鎻掍欢 SDK 鍜?host runtime 鐩稿叧 ADR銆俢omputer use spec 搴斿皢 capability銆乺untime銆乁I surface銆乨iagnostics銆乧onfiguration schema銆乸latform support銆乼hreat model銆乤cceptance tests 鍒嗙珷锛屽苟鏄庣‘鎵€鏈?host API 濂戠害銆?
## 璇佹嵁杈圭晫

codeg 婧愮爜鑳借瘉鏄庝笂杩板伐鍏枫€佹巿鏉冦€乭elper 鍗忚銆乁I銆佹祴璇曞拰鍙戝竷瑙勫垯鐨勫疄鐜版剰鍥撅紱瀹冧笉鑳藉崟鐙瘉鏄庡悇 OS driver 瀵规墍鏈夊簲鐢ㄧ殑瀹為檯鎴愬姛鐜囥€佷笉鍙粫杩囨€ф垨 UX 鍙敤鎬с€傚挨鍏?CUA driver 鐨勫疄闄呰涓轰緷璧栧钩鍙颁笌鍏蜂綋搴旂敤锛宻ource comments 涓殑绾︽潫搴旇涓哄疄鐜版剰鍥撅紝鍙戝竷绛惧悕妫€鏌ヤ笌杩愯鏃堕獙璇佹墠鏄儴鍒嗗彲瀹¤淇濊瘉銆傛湰鏂囨湭鎶?codeg 鐨勬柟妗堝綋浣滄硶寰?瀹夊叏璁よ瘉锛屼篃鏈鏌ヨ繍琛屼腑鐨勬闈㈣涓恒€?
