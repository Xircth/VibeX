# 巨量千川 CDP 自动化采集与执行脚本说明

> **来源开源项目**：[`fengx8534-tech/qianchuan-ads-automation`](https://github.com/fengx8534-tech/qianchuan-ads-automation)  
> **说明**：本文件夹已将该项目中所有涉及 Chrome CDP 连接、7 路千川数据采集、页面受控动作执行及页面接口拦截的核心脚本单独提取并按功能重命名；同时已将各脚本内部的 `require(...)` 相对引用路径同步更新为新文件名，确保在同一目录下可直接调用。

---

## 脚本清单与功能对照表

| 序号 | 脚本文件名 | 原项目文件名 | 核心功能说明 |
| :--- | :--- | :--- | :--- |
| **01** | `01_CDP浏览器连接与标签页控制底座(cdp-client).js` | `local-backend/executor/cdp-client.js` | 连接 Chrome `:9222` 远程调试端口、枚举与打分匹配千川标签页（`scoreQianchuanTab`）、打开新标签页、执行页面 JS 表达式及切换“今日”日期筛选器 |
| **02** | `02_直播大屏实时指标采集脚本(board-collector).js` | `local-backend/executor/board-collector.js` | 采集千川「直播大屏」核心指标（整体成交金额 GMV、智能成交订单、GPM 千次观看成交、观看人数、实时在线人数等） |
| **03** | `03_直播大屏1-5-30分钟趋势采集脚本(board-trend-collector).js` | `local-backend/executor/board-trend-collector.js` | 采集直播大屏 1 分钟、5 分钟、30 分钟粒度的消耗、成交金额与 ROI 实时趋势变化 |
| **04** | `04_全域计划消耗与ROI采集脚本(plan-collector).js` | `local-backend/executor/plan-collector.js` | 采集全域推广主计划表的基础消耗、整体消耗、计划 ROI 与投放状态 |
| **05** | `05_小时级投放明细与视觉截图采集脚本(visual-capture).js` | `local-backend/executor/visual-capture.js` | 采集当前小时级消耗、ROI 明细，并支持对千川关键区域进行 CDP 视觉截图留存 |
| **06** | `06_调控任务中心(追投-控成本-起量)采集脚本(task-collector).js` | `local-backend/executor/task-collector.js` | 采集千川全域「调控任务中心」下的素材追投、控成本追投、一键起量等子任务列表、消耗占比与实时状态 |
| **07** | `07_素材库指标与审核状态采集脚本(material-collector).js` | `local-backend/executor/material-collector.js` | 采集千川素材库中各视频素材的消耗、ROI、点击率（CTR）、转化率（CVR）及素材审核状态 |
| **08** | `08_优质候选素材TOP3实时筛选脚本(material-screener).js` | `local-backend/executor/material-screener.js` | 基于素材库采集结果进行实时评分排序，筛选出适合新建追投的 TOP 3 优质候选素材 |
| **09** | `09_千川页面受控动作执行器(暂停-加预算-改ROI-新建追投)(action-executor).js` | `local-backend/executor/action-executor.js` | **核心 CDP 页面动作执行器**：支持自动点击暂停任务、增加预算、延长投放时长、修改 ROI 目标、新建素材追投、新建一键起量（内置二次验证与预览截图保护） |
| **10** | `10_千川页面URL路由解析与上下文构建工具(qianchuan-url).js` | `local-backend/lib/qianchuan-url.js` | 从千川 URL 中提取 `aavid`（账户 ID）、`adId`（计划 ID）、`live_room_id`（直播间 ID），并拼接直播大屏与任务中心标准跳转链接 |
| **11** | `11_采集数据完整性校验模块(collection-integrity).js` | `local-backend/lib/collection-integrity.js` | 校验各路 CDP 采集器返回的数据结构是否完整、是否存在缺页或空数据异常 |
| **12** | `12_CDP端口与千川只读标签页初始化巡检脚本(check-and-open-dashboard).js` | `skills/.../check-and-open-dashboard.js` | 启动前自动探测 `:9222` CDP 端口连通性，并自动补齐缺失的千川只读监控标签页 |
| **13** | `13_页面API请求拦截与数据捕获脚本(extension-injector).js` | `chrome-extension/injector.js` | 注入千川页面上下文，直接 Hook `window.fetch` 与 `XMLHttpRequest`，无感捕获千川后台原生接口返回的 JSON 报表数据 |
| **14** | `14_千川页面DOM提取与消息桥接脚本(extension-content).js` | `chrome-extension/content.js` | 负责从千川网页 DOM 提取指标卡片数据，并将拦截到的接口数据转发给本地服务 |
| **15** | `15_千川页面中英文指标字段映射表(extension-field-map).js` | `chrome-extension/field-map.js` | 千川后台各类中文指标名称与英文标准字段名（如 `cost`、`roi`、`gmv`、`gpm` 等）的映射字典 |

---

## 前置启动方式（开启 Chrome CDP 端口）

在使用上述 CDP 脚本前，需先使用独立配置目录开启带 `9222` 远程调试端口的 Chrome 并登录巨量千川后台：

**Windows (PowerShell)：**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\qianchuan-cdp"
```
