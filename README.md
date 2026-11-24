# dsh-cross-model-bridge

[![version](https://img.shields.io/badge/version-2.1.0-blue)](https://github.com/ZhangJinHui0627/dsh-cross-model-bridge/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20DSH%20Desktop-lightgrey)](#安装--卸载)

**DSH（DeepSeek Harness）跨模型 / 跨账号智能任务接力桥（v2.1.0 工业级版）**。

专为在 DeepSeek Harness 会话中切换模型或轮换账号设计。通过**三段式结构化思维预算抽取**、**Prompt Cache 友好型 XML 协议**与**两阶段安全提交**，彻底解决原生切换时的思考被静默丢弃、多账号切换目标断层、代码块被生硬腰斩破坏 Markdown、以及跨模型调用触发 `PROVIDER_ERROR` 流式崩溃的痛点。

---

## 核心架构与设计升级（v2.1.0）

```text
【用户对话历史】
      │
      ▼
┌──────────────────────────────────────────────────────────────────┐
│ dsh-cross-model-bridge 智能拦截器（Cordis 宿主层 async function*）  │
└──────────────────────────────────────────────────────────────────┘
      │
      ├─▶ 阶段一：出站判定与三段式结构化思维抽取（prepareRequest）
      │     ├─ 首部 15%：锁定前序初始核心任务目标与技术约定约束
      │     ├─ 锚点 25%：正则提炼关键决策信号句（排除/放弃/必须/最终等），带正文去重
      │     ├─ 尾部 60%：提取末尾关键推演收敛证据，动态预算自动回流
      │     ├─ 代码块安全围栏保护：绝不把 ``` / ~~~ 从中间腰斩破坏 Markdown
      │     └─ 语义标点吸附（句末标点 / 换行）+ 中英双语权重估算（ASCII 0.25, 汉字 1.0）
      │
      ├─▶ Prompt Cache 友好型与防套娃 XML 协议构建
      │     ├─ 绝不碰顶层 system / developer 消息，100% 保持前缀 KV Cache 命中
      │     ├─ 采用结构化标签：<internal_handoff data-dsh-bridge="1">
      │     ├─ 幂等清洗历史旧 handoff 块，彻底杜绝 A->B->C 连续切换时的无限套娃
      │     ├─ 保护 Agent 工具链：避开破坏 tool_use 与 tool_result 的紧邻性
      │     └─ 空消息 (continued) 兜底：防止剥离思考后变为空消息触发 400 报错
      │
      ├─▶ 规范流式生成器委派（yield*）
      │     └─ 消费各厂商 AsyncIterable 数据块，彻底根治 PROVIDER_ERROR
      │
      ▼
┌──────────────────────────────────────────────────────────────────┐
│ 阶段二：流式安全响应后提交状态（commitResponse）                      │
│ 遇到 429 限流 / 超时中断不污染状态，重试依然能无缝接棒 · 隔离落盘     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 为什么需要它（核心对比）

| 场景问题 | 传统简单截断方案 | v2.1.0 工业级方案 |
|---|---|---|
| **末尾硬截断的信息盲区** | 容易切断在前期排错已排除的死路上，丢失初始目标；容易切在代码块中间留下单数反引号导致 Markdown 渲染错乱。 | **首+锚点+尾三段式**：15% 锁定初始目标，25% 提取关键排错/决策锚点，60% 保留收敛推演；内置代码块完整性边界与标点吸附。 |
| **Prompt Cache（KV Cache）失效** | 改写顶层 System 消息导致 Anthropic/OpenAI/Gemini/DeepSeek 的 KV Cache 全量失效，首字延迟（TTFT）与费用飙升。 | **缓存友好挂载**：绝对不改动 System 消息，将结构化 `<internal_handoff>` 挂载在最新 User 消息边界，维持极高缓存命中率。 |
| **多模型连续切换套娃污染** | 用户 A → B → C 轮换，历史消息中残留大量旧 handoff 提示词，越用越臃肿。 | **多跳幂等清洗**：注入新协议前，自动正则清洗历史中所有旧残留块，保持全篇上下文极简干净。 |
| **Agent 工具调用（Tool Call）报错** | 在 `tool_use` 与 `tool_result` 之间强行插入文本，导致厂商 API 报 400 校验失败。 | **工具调用紧邻保护**：跳过所有 `tool` 角色，挂载在最后一个 `tool_result` 之后；剥离思考导致 assistant 为空时自动补入 `(continued)`。 |
| **429 限流或超时导致状态错乱** | 出站即提前修改状态，遭遇 429 限流点击重试时被误判为同路由，导致接棒丢失。 | **两阶段安全提交**：出站仅改写不改状态，只有下游流式真正成功完成时才提交状态与落盘。 |

---

## 协议与抽取示例

```xml
<internal_handoff data-dsh-bridge="1" from="gemini-3.8-flash" mode="cross-model">
[跨模型接棒导航（gemini-3.8-flash → GLM-5.3-Flash）]
系统提示：当前会话已交接给你承接。请直接继承前文所有技术决定与既有进度，保持风格一致，切勿向用户复述本段标记。

1. 用户核心需求为实现 Java 集合类的示例与对比测试；

【关键决策与排错项】
- 排除在原有单类中混合实现的方案，避免引入不必要的耦合；
- 决定分别建立独立类 IteratorExample 与 ArrayListExample 并全量编译；

最终确认比对控制台输出与预期屏幕完全一致，继续向下推进。

Use this as your prior working memory and respond directly to the user.
</internal_handoff>
```

---

## 配置说明

在配置文件（或 `cordis.patch.yml`）中支持以下参数：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxThinkingTokens` | `500` | 思考链三段式抽取的 Token 预算上限（约 500~800 汉字） |
| `headRatio` | `0.15` | 首部初始目标预算占比（15%） |
| `midRatio` | `0.25` | 中部决策锚点预算占比（25%） |
| `tailRatio` | `0.60` | 尾部收敛推演预算占比（60%，中段剩余预算自动回流） |
| `asciiWeight` | `0.25` | ASCII 字符 Token 权重（0.25） |
| `nonAsciiWeight` | `1.0` | 非 ASCII 字符（汉字/全角）Token 权重（1.0） |
| `keepThinkingTurns`| `1` | 为最近 N 轮跨路由 assistant 消息注入思考（默认 1） |
| `lang` | `'zh'` | 提示语言 |

---

## 安装与生效

```powershell
# 部署安装至 desktop profile
pwsh -File install-profile.ps1

# 如需卸载
pwsh -File install-profile.ps1 -Uninstall
```

- **前端热更新**：在 DeepSeek Harness 窗口中按 **`Ctrl + R`** 即可即时加载最新面板；
- **后端生效**：完全退出并重新打开 DeepSeek Harness 客户端即可加载全新流式拦截器。

---

## 代码来源与致谢

- 本插件基于 [DeepSeek Harness](https://github.com/deepseek-ai) 官方插件体系与 [Cordis](https://cordis.moe) 服务发现框架；
- 特别鸣谢《**DeepSeek Harness 跨模型插件客观评价**》（含 30 页深度分析与参考代码）对本插件提出的中肯评测、三段式结构化思维抽取算法（首+锚点+尾）、Prompt Cache 保护思路与防套娃清洗机制；
- 参考并借鉴了官方插件 `dsh-session-checkpoint-policy` 的流式拦截改写模式与 `dsh-codex-effort-slider` 的无侵入式 Junction 部署方式。
