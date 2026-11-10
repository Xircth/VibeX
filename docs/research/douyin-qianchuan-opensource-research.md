# 抖音巨量千川（Qianchuan）智能投放策略、数据监测与数据收集开源项目全景调研报告

> **调研时间**：2026-11-08  
> **检索范围**：GitHub 开源仓库、巨量引擎商业开放平台（OceanEngine Marketing API）官方生态、MCP / Agent 技能生态  
> **覆盖维度**：智能投放策略与自动调控、数据采集（OpenAPI / 浏览器 CDP / 多源报表）、实时盯盘与异常诊断、素材复盘与 SDK 基础设施

---

## 一、 核心调研结论（Executive Summary）

1. **生态格局分化明显（「官方 OpenAPI 路线」vs.「浏览器 CDP + AI Agent 路线」）**：
   - 由于巨量引擎/巨量千川官方 OpenAPI（Marketing API）对**开发者资质（企业认证、MCN/代理商资质、接口配额审批）**要求较高，中小商家与个人投手很难拿到完整的写操作 API 权限。
   - 因此，当前 GitHub 上的千川开源项目明显分化为两大阵营：
     - **路线 A（浏览器 CDP / Playwright + 大模型 Agent 路线）**：直接复用用户本机已登录千川后台的 Chrome/Edge 会话，通过 DOM/接口拦截做**分钟级直播大屏采集**，结合 DeepSeek/Claude/Codex 生成策略建议，再通过受控脚本执行**暂停、加预算、改 ROI、新建素材追投**（代表作：`qianchuan-ads-automation`、`juliang-qianchuan-auto-ads-v1`、`qianchuan-chase-task`）。
     - **路线 B（官方 OpenAPI / MCP + 规则与算法引擎路线）**：基于巨量开放平台 Marketing API 或 CSV 导出报表，构建多账户管理、6 维异常规则诊断、Thompson Sampling（汤普森采样）自学习出价与自动止损闭环（代表作：`localads-engine`、`ad-review-analyst`、`bububa/oceanengine`、`mcp-cn-commerce`）。
2. **「智能投放策略」成熟度现状**：
   - **最成熟的开源策略引擎**反而在巨量本地推/千川同源的 `Prajna11/localads-engine`（内置 Thompson Sampling 多臂老虎机探索利用平衡、0 转化双重止损、冷启动出价保护、风险熔断器）和 `fengx8534-tech/qianchuan-ads-automation`（直播间每 5 分钟三段式 AI 盯盘 + 追投占比红线护栏）。
   - **安全共识高度一致**：几乎所有高质量开源项目均遵循**「默认 `DRY_RUN`（只出策略不落点击）+ 人工审批确认 + 熔断上限」**，绝不让大模型无护栏裸跑扣费操作。

---

## 二、 核心开源项目分类深度拆解

### 第一类：智能投放策略与自动盯盘调控系统（含 AI 决策 + 自动执行）

#### 1. [`fengx8534-tech/qianchuan-ads-automation`](https://github.com/fengx8534-tech/qianchuan-ads-automation) —— 基于 Chrome CDP 与 DeepSeek 的千川直播投放实时调控台
- **技术栈**：Node.js + Chrome CDP (`:9222`) + DeepSeek API + 钉钉 Webhook
- **数据收集能力（7 路串行采集器）**：
  1. `board-collector.js`：采集直播大屏实时订单、GPM（千次观看成交额）、观看与在线人数；
  2. `board-trend-collector.js`：采集 1 / 5 / 30 分钟消耗、成交、ROI 趋势；
  3. `plan-collector.js`：采集基础消耗、计划总消耗、计划 ROI；
  4. `visual-capture.js`：采集当前小时级消耗与 ROI 明细；
  5. `task-collector.js`：采集追投、控成本、一键起量任务状态；
  6. `material-collector.js` & `material-screener.js`：采集素材库 ROI/CTR/CVR/审核状态并实时筛选 TOP 3 候选素材。
- **智能投放策略与执行**：
  - **AI 决策引擎**：每 5 分钟组装 16 项实时指标与用户自定义 SOP，调用 DeepSeek 输出「三段式分析推理 + 候选动作指令」。
  - **CDP 受控执行器（`action-executor.js`）**：支持自动执行**暂停计划、增加预算、延长时长、修改 ROI 目标、新建素材追投、新建一键起量**。
  - **安全护栏**：默认开启 `executorDryRun`；追投消耗占比达到 **28%** 时硬编码禁止新建追投；每小时执行次数设上限；创建类动作强制先填表截图预览、经人工点击审批后才落真实点击。

#### 2. [`Prajna11/localads-engine`](https://github.com/Prajna11/localads-engine) —— 巨量引擎/本地推自学习自动投放与策略校准系统（架构最完整的投放策略参考）
- **技术栈**：Python 3.11 + SQLAlchemy/SQLite + APScheduler + pandas/SciPy/scikit-learn + Prometheus/Grafana
- **核心价值**：虽然默认适配巨量本地推与抖音来客网页端接口，但其**数据建模、策略判断、Thompson Sampling 学习校准与熔断治理层**是目前开源界最完整的字节系广告自学习投流架构，可直接平滑迁移至千川接口。
- **内置 6 大投放策略算法**：
  1. **素材探索与利用平衡（Bandit 策略）**：采用 Thompson Sampling（汤普森采样）与 IPW（逆概率加权），在“已有转化证据的稳定素材”与“低消耗待验证新素材”之间动态分配流量，避免素材池过早收敛或重复占用。
  2. **生命周期止损策略**：0 转化计划按「消耗阈值 + 运行时长」双重止损；有转化计划结合转化停滞与后端有效率动态延长或加速关停。
  3. **出价与预算收敛策略**：新计划按目标成本 + 冷启动保护定初始出价；运行中拒绝盲目加价追逐 0 转化计划，仅对有转化但成本偏高的计划做降价/限额收敛。
  4. **满仓替换扩量策略**：受总预算上限与在投健康度约束，满仓时优先评估替换弱计划而非盲目叠加并发计划。
  5. **小步后验校准（`src/learner`）**：样本或反馈不足时冻结权重，充足时小步更新素材评分与止损参数。
  6. **三级执行熔断（`circuit_breaker.py`）**：默认 `DRY_RUN`；切换 `AUTO` 后对异常消耗、连续失败自动触发单计划与全局熔断。

#### 3. [`zhujiushequn/juliang-qianchuan-auto-ads-v1`](https://github.com/zhujiushequn/juliang-qianchuan-auto-ads-v1) —— 基于 OpenClaw 的巨量千川直播加热自动投流技能包
- **技术栈**：Node.js + OpenClaw Agent 框架 + Chrome CDP + 飞书机器人
- **核心能力**：
  - **飞书指令触发**：在飞书向机器人发送“开始直播了”即可触发全域投放/品牌竞价直播加热流程。
  - **本地台账防重（`qianchuan-plan-registry.json`）**：自动新建或复用广告组，基于本地台账对计划名与行为兴趣词查重，避免重复建计划互相抢量。
  - **15 分钟轮询盯盘**：跨分页读取全部监控清单计划（严禁只读首屏 10 条误判），每 15 分钟巡检一次计划数据，达标后按配置自动标记待删或直接删除。

#### 4. [`zhenxin2005/qianchuan-chase-task`](https://github.com/zhenxin2005/qianchuan-chase-task) —— 千川全域投放「素材追投 + 达人定向」自动化 Skill
- **技术栈**：Playwright CLI + Agent Skill 规范
- **核心能力**：专门针对千川「全域投放（`uni-prom`）」下的**控成本追投 / 放量追投**场景。封装了分步交互向导、自动处理千川后台 `.auxo-modal-wrap` 遮罩层、自动勾选 6 项高意向达人互动场景（直播有效观看/评论/商品点击/下单、购物车点击/下单）及批量搜索绑定抖音达人名单的完整 DOM 操控技巧。

---

### 第二类：千川数据监测、异常诊断与自动化报表采集

#### 1. [`ChenYouXin8/ad-review-analyst`](https://github.com/ChenYouXin8/ad-review-analyst) —— 巨量千川智能复盘与 6 维异常诊断 Agent 系统
- **技术栈**：Java 21 + Spring Boot 4.1 + Spring AI 2.0 + 巨量千川 MCP + Vue 3 / ECharts + H2
- **数据收集双模驱动（`LOCAL_IMPORT > MCP_LIVE > MOCK_FALLBACK`）**：
  -既支持直连**巨量引擎官方 MCP 服务**实时拉取千川数据，也支持直接导入**千川后台导出的 CSV 报表**（自适应 UTF-8/GBK 编码与中英文表头映射，零 API 资质门槛即可跑通）。
- **核心监测与策略诊断能力**：
  - **6 维参数化异常诊断引擎**：内置 `LOW_ROI`（ROI 偏低）、`HIGH_CPA`（转化成本过高）、`LOW_CTR`（点击率低迷）、`BUDGET_OVERSPEND`（消耗超全场均值 2.5 倍且低产出）、`CREATIVE_DECAY`（素材审美疲劳、CPC 高于均值 1.5 倍）、`SUDDEN_DROP`（多日 ROI 断崖下跌或大额零转化空耗）。
  - **Request-Scoped Tool Calling**：通过有状态工具按需检索 TopN 计划与异常明细，避免把全量报表塞进 Prompt 导致 Token 爆炸。

#### 2. [`639happy/qianchuan-live-weekly-report-skill`](https://github.com/639happy/qianchuan-live-weekly-report-skill) —— 抖音电商罗盘 + 巨量千川联动周报采集与核算 Skill
- **技术栈**：Python + Chrome 插件自动化 / CSV 文件模式 + 飞书 `lark-cli` / Excel
- **核心能力**：
  - 打通**抖音电商罗盘**（`compass.jinritemai.com`）与**巨量千川**（`qianchuan.jinritemai.com`）双后台数据。
  - 自动计算**直播成交漏斗、自然流 vs. 付费流观看结构、自然流撬动系数、千次观看成交额（GPM）、综合营销 ROI（净成交 ROI）**，并校验退款成熟度。
  - 自动生成并回读校验四张标准表（`场次核心明细`、`周报汇总`、`数据底表`、`数据字典`），支持一键写入飞书表格或本地 Excel。

#### 3. [`TonyWang-hub/mcp-cn-commerce`](https://github.com/TonyWang-hub/mcp-cn-commerce) —— 中国电商与巨量千川 MCP 数据连接器套件
- **技术栈**：Python 3.11+ + 官方 MCP SDK（支持 Claude Code、Codex、OpenCode 直接挂载）
- **核心能力**：提供 `mcp-cn-oceanengine` 与 `mcp-cn-doudian` 独立 stdio MCP Server，默认**纯只读安全设计**，内置连接池、限流重试、链路追踪与确定性日报生成工具（`build_daily_report`），适合让 AI Agent 同时结合抖店订单/售后退款数据与千川广告账户数据做联合 ROI 分析。

#### 4. [`ruiyukirin/douyin-oem-touliu-report`](https://github.com/ruiyukirin/douyin-oem-touliu-report) & [`bettermen/ad-trader`](https://github.com/bettermen/ad-trader)
- **`douyin-oem-touliu-report`**：基于 Playwright + Edge 持久化登录态，每日定时自动采集「客资中心 + 计划级投放明细 + 视频分析」三源数据，检测连续 2 日（P1）/ 3 日（P0）异常波动，自动产出带 8 天对比的深度分析 Word 报告并推送邮件。
- **`ad-trader`**：面向广告优化师的 Python 诊断工具，内置**「532 预算分配法则」**（50% 优质计划 + 30% 潜力计划 + 20% 测试计划）、基于 ROAS+转化量的出价决策矩阵以及素材疲劳度评分模型，一键生成交互式 Chart.js HTML 诊断报告。

---

### 第三类：千川视频素材监测、拆解与编导实验工具

1. **[`3132882323-cyber/douyin-qianchuan-creative-director-agent`](https://github.com/3132882323-cyber/douyin-qianchuan-creative-director-agent)**（Chrome/Edge 扩展）：专为千川素材编导打造的单变量 A/B 测试工作台。支持导入千川素材报表复盘历史基线（B00），严格锁定单变量（前三秒钩子 / 核心主张 / 场景 / 受众）生成变体方案（A01/A02），管理测试消耗门槛与 ROI 回填闭环。
2. **[`liberalwhy/AI-qianchuan-video-agent`](https://github.com/liberalwhy/AI-qianchuan-video-agent)**（Python + Streamlit + OpenCV/FFmpeg）：千川视频素材秒级点击高峰识别与关键帧诊断工具。结合千川视频秒级点击数据定位流失点与高光秒点，自动截取关键帧并提取画面 OCR 文字、口播文本与创意标签，识别“高点击低转化”与“高消耗低 ROI”素材。
3. **[`bianzigege/qianchuan-material-breakdown-skill`](https://github.com/bianzigege/qianchuan-material-breakdown-skill)**：千川爆款素材本地预处理、口播转写、镜头切分与卖点结构拆解归档到飞书/钉钉的自动化 Skill。

---

### 第四类：巨量千川 / 巨量引擎底层 OpenAPI SDK 与全栈管理脚手架

如果需要基于官方接口自研企业级千川投流中台，以下是最成熟的开源底座：

| 项目名称 | 语言 / 技术栈 | 定位与千川覆盖度 | 活跃度与推荐度 |
| :--- | :--- | :--- | :--- |
| **[`bububa/oceanengine`](https://github.com/bububa/oceanengine)** | Go | **社区最完善、维护最活跃的巨量引擎 & 千川 Golang SDK**。完整覆盖千川 OAuth2、账户预算、标准推广、随心推（`aweme`）、全域推广（`uni_promotion`）、计划/素材/直播间实时报表、DMP 人群与关键词管理 | ⭐⭐⭐⭐⭐（首选 Go 底座） |
| **[`oceanengine/ad_open_sdk_go`](https://github.com/oceanengine/ad_open_sdk_go)**<br>**[`oceanengine/ad_open_sdk_java`](https://github.com/oceanengine/ad_open_sdk_java)** | Go / Java | **巨量引擎官方开源 SDK**。与官方 OpenAPI 文档同步更新（2026 年持续高频提交），包含 `/open_api/v1.0/qianchuan/` 下全域直播/视频创编、今日直播间大盘、广告与素材报表等全量结构体 | ⭐⭐⭐⭐⭐（官方权威底座） |
| **[`whalesky-labs/oceanengine-sdk-php`](https://github.com/whalesky-labs/oceanengine-sdk-php)** | PHP | 支持巨量广告、**巨量千川（PC 标准推广 + 全域推广）**、本地推、星图全模块，带连接复用、频控重试与直播分析报表 | ⭐⭐⭐⭐（PHP 首选） |
| **[`fudiwei/DotNetCore.SKIT.FlurlHttpClient.ByteDance`](https://github.com/fudiwei/DotNetCore.SKIT.FlurlHttpClient.ByteDance)** | C# / .NET | 全网最全的 C# 字节跳动生态 SDK，完整封装抖店开放平台、巨量引擎与千川 OpenAPI | ⭐⭐⭐⭐（.NET 首选） |
| **[`tkkgkv4crz-ui/qianchuan-ai-tool`](https://github.com/tkkgkv4crz-ui/qianchuan-ai-tool)**<br>**[`wu-shaobing/go_qianchuan`](https://github.com/wu-shaobing/go_qianchuan)**<br>**[`cn755/go_oceanengine`](https://github.com/cn755/go_oceanengine)** | FastAPI + Vue3<br>Go + React/Vue | 基于官方/社区 SDK 封装的千川 Web 管理后台脚手架（含可视化 OAuth 授权助手、计划列表、全域推广与报表看板） | ⭐⭐⭐（适合作为管理后台 UI 原型参考） |

---

## 三、 选型与落地建议（针对不同业务场景）

1. **如果你没有巨量开放平台企业级写操作 API 资质（或主要投「全域推广 / 直播间实时盯盘」）**：
   - **最佳组合**：参考 **[`fengx8534-tech/qianchuan-ads-automation`](https://github.com/fengx8534-tech/qianchuan-ads-automation)**（7 路 CDP 实时采集 + 5 分钟 AI 盯盘 + 审批执行）+ **[`zhenxin2005/qianchuan-chase-task`](https://github.com/zhenxin2005/qianchuan-chase-task)**（全域素材追投與达人定向 DOM 自动化）+ **[`639happy/qianchuan-live-weekly-report-skill`](https://github.com/639happy/qianchuan-live-weekly-report-skill)**（罗盘+千川综合净成交 ROI 周报核算）。
   - **优势**：零 API 申请门槛，100% 还原真人投手在千川网页端所能看到的实时大屏、全域调控任务与追投功能。
2. **如果你有官方 OpenAPI 权限，想构建「长周期自学习智能投放与风控引擎」**：
   - **最佳组合**：底层通信用 **[`bububa/oceanengine`](https://github.com/bububa/oceanengine)** 或官方 SDK，核心策略层直接借鉴 **[`Prajna11/localads-engine`](https://github.com/Prajna11/localads-engine)** 的 **Thompson Sampling 素材探索算法 + 生命周期止损 + 风险熔断器**，复盘诊断层参考 **[`ChenYouXin8/ad-review-analyst`](https://github.com/ChenYouXin8/ad-review-analyst)** 的 **6 维参数化异常规则引擎**。
3. **如果你希望直接在 VibeX 中通过 Agent / Skill 赋能千川投流**：
   - 可以将上述 **`qianchuan-ads-automation` 的 7 路采集与护栏规则**、**`ad-review-analyst` 的 6 维异常诊断指标** 以及 **`localads-engine` 的 Bandit 出价/止损算法** 整合封装为一个标准的 VibeX Plugin 或 Skill，配合 VibeX 现有的浏览器工具与审批流（`request_permission` 人工确认后才执行调价/建计划），即可快速形成一套安全可控的「千川 AI 投手工作台」。
