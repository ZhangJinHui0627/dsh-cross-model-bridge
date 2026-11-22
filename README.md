# dsh-cross-model-bridge

[![version](https://img.shields.io/badge/version-1.0.2-blue)](https://github.com/ZhangJinHui0627/dsh-cross-model-bridge)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#安装--卸载)

**DSH（DeepSeek Harness）跨模型思考桥**：在同一个会话里切换模型时，把上一模型的
思考（reasoning 块）转写为正文文本标签，让新模型能读到上一模型的推演思路；
同时剔除注定被适配器丢弃的跨模型 reasoning 块——行为可预期、Token 可控。

```text
模型 A 深度推理 ──切模型──▶ 模型 B 接续回答
     │                              ▲
     └─ reasoning 块（签名失效,      │
        被适配器静默丢弃）      插件转写为正文标签,
                               B 看得到 A 的完整思路
```

## 为什么需要它

DSH 的规范消息里，思考是 assistant content 的 `{ type: 'reasoning', text }` 块；
原厂签名保存在 adapter 私有的 replayState 里，**只在同模型时校验回放**。
跨模型切换时签名必然失效：

| 适配器 | 对跨模型思考的处理 |
|---|---|
| DeepSeek 官方（`dsh-llm-deepseek`） | 降级为无签名 thinking 块 |
| pi-ai（`@earendil-works/pi-ai`，千问 openai-completions） | **静默丢弃**，不发送任何字段 |

无论哪种，新模型都看不到上一模型的推演过程。本插件在宿主层把跨模型思考
降级为正文文本，让推演接力不断线。

## 跨模型的判定规则

replay 是否有效取决于 **adapter 实例**，而 adapter 按 **provider 路由**注册
（`LlmRuntime` 只在该 adapter 同时拥有历史 provider 与目标 provider 时才暴露
replayState）。因此本插件把「provider 或 model 任一不同」都判定为跨模型：

| 历史来源 | 目标 | 判定 | 处理 |
|---|---|---|---|
| provider A / model X | provider A / model X | 同路由 | 完全不动（保住原生签名 replay） |
| provider A / model X | provider B / model X | **跨模型** | 转写为正文标签 |
| provider A / model X | provider A / model Y | **跨模型** | 转写为正文标签 |
| 无 source 信息 | 任意 | 保守 | 完全不动 |

> ⚠️ 只比较 model 会把「同名模型、不同 provider」误判为同模型，导致思考被
> 适配器静默丢弃——这是 1.0.0 的缺陷，1.0.1 已修复。同一模型挂多个 provider
> （如千问平台的多账号路由）正是最容易踩中的场景。

## 工作原理（全部走官方公开扩展点，无猴子补丁）

1. 监听 Cordis 瀑布事件 `'llm/stream'`（同官方 `dsh-session-checkpoint-policy` 的模式）；
2. 检测消息里是否存在"来源路由 ≠ 目标路由"的 reasoning 块；**没有则零开销直通**；
3. 有则克隆请求（保留 live 的 `AbortSignal`）：
   - 最近 `keepThinkingTurns` 条跨模型思考 → 转写为正文开头的文本标签；
   - 更早的跨模型思考 → 仅剔除 reasoning 块（适配器本来也会丢弃）；
   - 其余消息与块（tool-call、image、text）→ 原样保留；
4. 用 `ctx.llm.stream(clone)` 重新进入瀑布；WeakSet 标记防递归。

注入的标签自带"请勿复述本标签"的防模仿提示（pi-ai 官方为此特意使用无标签
纯文本；本插件保留显式标签以传达"前序思考"信号，附加不复述指令折中）。

注入效果示例：

```markdown
【前序模型 deepseek-v4.1-flash-1017 的推演思路（供接续参考）】
（以下为系统注入的历史上下文，仅供接续参考；请在回答中直接使用其结论，不要复述本标签或本段格式。）
1. 用户核心需求是……
2. 方案 A 存在……缺陷，因此排除……
3. 最终决策采用……
```

同模型历史**完全不动**——原生签名回放路径不受影响。

## 配置（cordis.patch.yml insert config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `keepThinkingTurns` | `1` | 为最近 N 条跨模型 assistant 消息注入思考文本；`0` = 完全不注入（仅剔除 reasoning 块，最省 Token） |
| `maxThinkingLength` | `3000` | 单条注入的最大字符数，超出截断 |
| `lang` | `zh` | 标签语言（`zh` / `en`） |

## 安装 / 卸载

在插件目录下执行：

```powershell
pwsh -File install-profile.ps1              # 装进 desktop profile
pwsh -File install-profile.ps1 -Uninstall   # 卸载
```

脚本做的事：备份 profile 的 `package.json` → 加 `link:` 依赖 → 追加 `dsh.profile.bundles`
→ 建 junction 链接 → 写回前校验。装完**完全退出并重开** DSH Desktop 生效。

## 验证方法

1. 用模型 A（如 `deepseek-v4.1-flash`）问一个需要推理的问题；
2. 同一会话切到另一个模型（如 `qwen3.8-max` 或 Claude）追问"我上一个问题你是怎么分析的？"；
3. 预期：新模型能复述 A 的推理思路，且消息正文开头带注入标签；
   GUI devtools 控制台出现 `cross-model-bridge: rewrote ...` 日志。

## 项目结构

```text
├── index.js            # 宿主半：llm/stream 瀑布监听 + 消息变换（全部逻辑在此）
├── cordis.patch.yml    # bundle patch 声明
├── install-profile.ps1 # 安装/卸载脚本（改写自 dsh-codex-effort-slider）
├── install.cmd         # Windows 双击入口（自动选择 pwsh/powershell）
├── package.json
└── README.md
```

## 开源参考与致谢

| 内容 | 来源 | 许可 |
|---|---|---|
| `'llm/stream'` 瀑布监听模式 | [@deepseek-ai/dsh-session-checkpoint-policy](https://github.com/deepseek-ai)、dsh-session-title | MIT |
| 消息/块词汇表、冻结语义、`markAgentLoopRequest` | [@deepseek-ai/dsh-llm](https://github.com/deepseek-ai) | MIT |
| 适配器跨模型思考降级行为的判定依据 | `dsh-llm-deepseek`、[@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) | MIT |
| 安装脚本 | dsh-codex-effort-slider `install-profile.ps1` | — |

## 许可

[MIT](LICENSE)
