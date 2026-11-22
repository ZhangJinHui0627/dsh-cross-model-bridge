# dsh-cross-model-bridge

DSH（DeepSeek Harness）跨模型思考桥：在同一个会话里切换模型时，把上一模型的思考
（reasoning 块）转写为正文文本标签，让新模型能读到上一模型的推演思路；同时剔除
注定被适配器丢弃的跨模型 reasoning 块，行为可预期、Token 可控。

## 为什么需要它

- DSH 的规范消息里，思考是 assistant content 的 `{ type: 'reasoning', text }` 块；
  原厂签名保存在 adapter 私有的 replayState 里，**只在同模型时校验回放**。
- 跨模型切换时签名必然失效：DeepSeek 官方适配器降级为无签名 thinking 块，
  pi-ai（千问 openai-completions）则**静默丢弃**无签名思考——新模型什么都看不到。
- 本插件在宿主层把跨模型思考降级为正文文本，推演接力不断线。

## 跨模型的判定规则

replay 是否有效取决于 **adapter 实例**，而 adapter 按 **provider 路由**注册
（LlmRuntime 只在该 adapter 同时拥有历史 provider 与目标 provider 时才暴露
replayState）。因此本插件把「provider 或 model 任一不同」都判定为跨模型：

| 历史来源 | 目标 | 判定 | 处理 |
|---|---|---|---|
| provider A / model X | provider A / model X | 同路由 | 完全不动（保住原生签名 replay） |
| provider A / model X | provider B / model X | **跨模型** | 转写为正文标签 |
| provider A / model X | provider A / model Y | **跨模型** | 转写为正文标签 |
| 无 source 信息 | 任意 | 保守 | 完全不动 |

> 只比较 model 会把「同名模型、不同 provider」误判为同模型，导致思考被适配器
> 静默丢弃——这是 1.0.0 的缺陷，1.0.1 已修复。

## 工作原理（全部走官方公开扩展点）

1. 监听 Cordis 瀑布事件 `'llm/stream'`；
2. 检测消息里是否存在"来源模型 ≠ 目标模型"的 reasoning 块；没有则零开销直通；
3. 有则克隆请求（保留 live 的 AbortSignal），把最近 `keepThinkingTurns` 条
   跨模型思考转写为正文开头的文本标签，更早的剔除；被改写消息里的裸
   reasoning 块一并剔除；其余消息、块（含 tool-call）原样保留；
4. 用 `ctx.llm.stream(clone)` 重新进入瀑布；WeakSet 标记防递归。

同模型历史**完全不动**——原生签名回放路径不受影响。

## 配置（cordis.patch.yml insert config）

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| keepThinkingTurns | 1 | 为最近 N 条跨模型 assistant 消息注入思考文本；设为 `0` 表示完全不注入（仅剔除 reasoning 块，最省 Token） |
| maxThinkingLength | 3000 | 单条注入的最大字符数 |
| lang | zh | 标签语言（zh/en） |

## 安装 / 卸载

```powershell
pwsh -File install-profile.ps1              # 装进 desktop profile
pwsh -File install-profile.ps1 -Uninstall   # 卸载
```
装完**完全退出并重开** DSH Desktop 生效。

脚本改写自 dsh-codex-effort-slider 的 install-profile.ps1（本地惯例一致：
备份 package.json → 加 link: 依赖 → 追加 bundles → junction 链接 → 校验）。

## 验证方法

1. 用模型 A（如 `deepseek-v4.1-flash`）问一个需要推理的问题；
2. 同一会话切到 `qwen3.8-max`（或 Claude）追问"我上一个问题你是怎么分析的？"；
3. 新模型应能复述 A 的推理思路（消息正文开头带"【前序模型 … 的推演思路】"标签），
   且宿主日志出现 `cross-model-bridge: rewrote ...`。

## 开源参考与致谢

| 内容 | 来源 | 许可 |
|---|---|---|
| 'llm/stream' 瀑布监听模式 | @deepseek-ai/dsh-session-checkpoint-policy、dsh-session-title | MIT |
| 消息/块词汇表、冻结语义、markAgentLoopRequest | @deepseek-ai/dsh-llm | MIT |
| 适配器跨模型思考降级行为的判定依据 | @deepseek-ai/dsh-llm-deepseek、@earendil-works/pi-ai | MIT |
| 安装脚本 | dsh-codex-effort-slider install-profile.ps1（本地） | — |

## 许可

MIT
