# dsh-cross-model-bridge

[![version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/ZhangJinHui0627/dsh-cross-model-bridge/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20DSH%20Desktop-lightgrey)](#安装--卸载)

**DSH（DeepSeek Harness）跨模型 / 跨账号智能任务接力桥**。

专为在 DeepSeek Harness 会话中切换模型或轮换账号设计。通过**出站系统级自感知接棒导航**与**关键推演证据收敛**，彻底解决原生切换时思考被静默丢弃、多账号切换上下文断层、以及跨模型调用触发 `PROVIDER_ERROR` 流式崩溃的痛点。

---

## 架构演进与核心特性（v2.0.0）

```text
【用户对话历史】
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ dsh-cross-model-bridge 智能接力检测（宿主 Cordis 拦截器）  │
└────────────────────────────────────────────────────────┘
      │
      ├─▶ 场景 A：同模型换账号（Provider 变更，Model 相同）
      │     └─ 注入【跨账号任务接棒导航】+ 继承决策目标
      │
      ├─▶ 场景 B：跨模型切换（Provider 或 Model 变更）
      │     ├─ 剥离底层私有 reasoning 签名（杜绝 400 与失效崩溃）
      │     ├─ 截取末尾收敛阶段关键推演证据（限 800 字，节省 75%+ Token）
      │     └─ 注入【跨模型任务接棒导航】规范接手行为
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ 接手 AI（GLM / Gemini / Claude / DeepSeek）自感知接棒  │
│ 零外部额外 AI 调用 · 零额外网络延迟 · 严格 AsyncIterable 流式 │
└────────────────────────────────────────────────────────┘
```

- 🤝 **接手 AI 自感知任务接力**：无需额外调用辅助小模型。在出站 Prompt 中向接手 AI 注入系统级导航协议，直接继承工作目标与已确认决策，无缝推进下一轮。
- 🧠 **关键推演证据收敛**：前序模型若有深度思考，自动舍弃前期漫长发散试错，仅提取末尾最接近最终结论的关键推演（限 800 字），Token 开销骤降 75% 以上；前序未开启深度思考亦能纯任务交接。
- 🛡️ **严格流式生成器契约**：彻底重构 `llm/stream` 拦截器为规范的 `async function*`，杜绝返回裸 Promise 引发的 `PROVIDER_ERROR`（模型通道暂时不可用）。
- 🪟 **物理吸顶与视口隔离面板**：右侧栏与会话主视图中，顶部状态栏物理吸顶不随滚轮滚动，提供“一键回顶最新”按键与“当前对话 / 全部对话”范围过滤。
- 💾 **防丢持久化与 Session 隔离**：记录自动防抖落盘至本地 `.bridge-events.json`（FIFO 上限 500 条），进程重启不丢失、多对话数据互不混杂。

---

## 为什么需要它

在 DeepSeek Harness 的原生机制中，深度思考以 assistant content 的 `{ type: 'reasoning', text }` 形式存储，依赖原厂私有签名进行验证：

| 切换场景 | 原生表现 | 插件解决方式 |
|---|---|---|
| **跨模型切换**<br>(如 Gemini → GLM-5.3) | 签名失效，适配器静默丢弃 reasoning 块；下游流式契约不兼容时触发 `PROVIDER_ERROR` | 剥离底层失效签名，注入任务接棒协议与 800 字推演收敛证据，生成器规范流式委派 |
| **同模型切账号**<br>(额度用尽轮换账号) | 适配器实例不同，思考可能被清空，新账号丢失当前任务目标与代码决策 | 精准识别同模型账号切换，直接继承已确认结论与进度，无需用户重新交代 |
| **全量思考直接注入** | 上万字发散式思考直接塞入正文，Token 迅速爆炸且容易让新模型复述自嗨 | 仅保留末尾 800 字最终收敛证据，并在协议中严正声明“仅供思路参考，勿向用户复述” |

---

## 判定与接力协议规范

### 1. 路由识别规则

| 历史来源 | 当前目标 | 判定分类 | 行为模式 |
|---|---|---|---|
| Provider A / Model X | Provider A / Model X | **同路由** | 完全原生直通（保留原生签名） |
| Provider A / Model X | Provider B / Model X | **跨账号（同模型）** | 注入同模型换账号接棒导航 |
| Provider A / Model X | Provider Any / Model Y | **跨模型** | 注入跨模型接棒导航 + 800 字关键推演收敛 |

### 2. 注入示例

```markdown
【跨模型任务接棒导航（gemini-3.8-flash → GLM-5.3-Flash）】
系统提示：检测到当前会话已交接给你承接。前序对话包含了完整的项目上下文与历史产出。
请接手模型在处理当前最新输入时，遵循以下接棒规范：
1. 【目标与进度继承】：从前序对话中直接继承当前核心任务目标与工作进度，无需用户重复交代；
2. 【结论与决策锁定】：严格遵守前文已确认的技术选型、设计决定与代码修改方案，勿重新论证已解决的问题；
3. 【无缝推进当前轮】：直接在上一轮的实际产出基础上继续推进下一步，保持代码风格与命名的一致性。

【前序关键推演收敛证据（供思路连贯参考，勿向用户复述）】：
> ……[更早过程性推演已自动收敛省略]
> 最终设计确认使用独立的 IteratorExample 与 ArrayListExample 示例类，全量编译并比对输出……
```

---

## 配置说明

在配置文件（或 `cordis.patch.yml`）中支持以下参数：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `keepThinkingTurns` | `1` | 只为最近 N 轮跨路由 assistant 消息注入接棒协议与推演证据（默认 1） |
| `maxThinkingLength` | `800` | 关键推演证据收敛的最大字符数（建议 800 字，取末尾收敛部分） |
| `lang` | `'zh'` | 导航提示语言（`zh` / `en`） |

---

## 安装与部署

本插件直连桌面环境 Profile，在插件根目录下执行：

```powershell
# 1. 部署安装至 desktop profile
pwsh -File install-profile.ps1

# 2. 如需卸载
pwsh -File install-profile.ps1 -Uninstall
```

> **提示**：安装或升级后，请完全退出 DeepSeek Harness 客户端并重新启动以加载后台插件。在客户端内按 `Ctrl + R` 可即时刷新前端界面。

---

## 项目结构

```text
├── index.js            # 宿主半：Cordis 瀑布流拦截器、智能接力检测、生成器流式委派、本地防抖持久化
├── client.js           # 浏览器半：右侧栏与主视图双入口、物理吸顶状态栏、按 Session 过滤与一键回顶
├── cordis.patch.yml    # bundle patch 声明
├── install-profile.ps1 # Profile 注册与 Junction 软链接脚本
├── install.cmd         # Windows 一键执行入口
├── package.json        # 插件元数据与 DSH Web 声明
└── README.md           # 技术架构与使用说明
```

---

## 代码来源与致谢

- 本插件架构基于 [DeepSeek Harness](https://github.com/deepseek-ai) 官方插件体系与 [Cordis](https://cordis.moe) 服务发现框架设计；
- 参考并借鉴了官方插件 `dsh-session-checkpoint-policy` 的 `llm/stream` 瀑布流式改写模式与 live `AbortSignal` 处理逻辑；
- 参考并借鉴了 `dsh-codex-effort-slider` 的 Profile Junction 无侵入式链接安装流程；
- 特别鸣谢开源社区中关于大语言模型跨架构切换、Token 上下文精简与推演接棒方案的讨论与灵感。
