import React from 'react';
import { useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

export const CrossModelDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 场景 1: 原生切模型报错 (0 ~ 40帧)
  const scene1Opacity = interpolate(frame, [0, 10, 35, 45], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // 场景 2: 桥接三段式抽取 (40 ~ 95帧)
  const scene2Opacity = interpolate(frame, [45, 55, 90, 95], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // 场景 3: 新模型无缝接棒输出 (95 ~ 140帧)
  const scene3Opacity = interpolate(frame, [95, 105, 135, 140], [0, 1, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{
      width: '100%', height: '100%',
      backgroundColor: '#0d1117', color: '#c9d1d9',
      fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      display: 'flex', flexDirection: 'column', padding: '24px', boxSizing: 'border-box'
    }}>
      {/* 顶部标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #30363d', paddingBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff5f56' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ffbd2e' }} />
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#27c93f' }} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#8b949e', marginLeft: '12px' }}>
            DeepSeek Harness · 会话流跨模型切换演练
          </span>
        </div>
        <div style={{ fontSize: '12px', background: '#21262d', padding: '3px 8px', borderRadius: '4px', color: '#58a6ff' }}>
          v2.1.0 工业级接力
        </div>
      </div>

      {/* 动态内容区 */}
      <div style={{ flex: 1, position: 'relative', marginTop: '16px' }}>
        {/* 场景 1 */}
        <div style={{ position: 'absolute', inset: 0, opacity: scene1Opacity, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ padding: '4px 10px', background: '#1f6feb', borderRadius: '6px', fontSize: '13px', color: '#fff' }}>Gemini 3.8 Flash</span>
            <span style={{ color: '#8b949e' }}>──切模型──▶</span>
            <span style={{ padding: '4px 10px', background: '#8957e5', borderRadius: '6px', fontSize: '13px', color: '#fff' }}>GLM-5.3-Flash</span>
          </div>
          <div style={{ padding: '16px', background: '#3d1214', border: '1px solid #f85149', borderRadius: '8px', color: '#ff7b72' }}>
            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>❌ 原生切换痛点：PROVIDER_ERROR & 思考丢弃</div>
            <div style={{ fontSize: '12px', lineHeight: '20px', color: '#ffa198' }}>
              • 适配器签名失效，上万字 reasoning 推演被静默丢弃，新模型发生“失忆”<br/>
              • 异步生成器流式契约冲突，触发通道崩溃报错
            </div>
          </div>
        </div>

        {/* 场景 2 */}
        <div style={{ position: 'absolute', inset: 0, opacity: scene2Opacity, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ padding: '3px 8px', background: 'rgba(56,139,253,0.15)', border: '1px solid #388bfd', borderRadius: '6px', fontSize: '12px', color: '#58a6ff' }}>
              ⚡ dsh-cross-model-bridge 自动拦截激活
            </span>
            <span style={{ padding: '3px 8px', background: 'rgba(46,160,67,0.15)', border: '1px solid #2ea043', borderRadius: '6px', fontSize: '12px', color: '#3fb950' }}>
              KV Cache 100% 保护（System 零篡改）
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '10px' }}>
            <div style={{ padding: '12px', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px' }}>
              <div style={{ color: '#58a6ff', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>🎯 首部 15%</div>
              <div style={{ fontSize: '11px', color: '#8b949e', lineHeight: '16px' }}>锁定前序核心目标与向后兼容规范</div>
            </div>
            <div style={{ padding: '12px', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px' }}>
              <div style={{ color: '#d29922', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>📍 决策锚点 25%</div>
              <div style={{ fontSize: '11px', color: '#8b949e', lineHeight: '16px' }}>正则提炼排错决策，带正文去重</div>
            </div>
            <div style={{ padding: '12px', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px' }}>
              <div style={{ color: '#a371f7', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>🏁 收敛尾部 60%</div>
              <div style={{ fontSize: '11px', color: '#8b949e', lineHeight: '16px' }}>代码块围栏防护，绝不从 ``` 腰斩</div>
            </div>
          </div>
          <div style={{ padding: '10px 14px', background: '#091e3a', border: '1px solid #1f6feb', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace', color: '#79c0ff' }}>
            &lt;internal_handoff data-dsh-bridge="1" from="Gemini" mode="cross-model"&gt;<br/>
            &nbsp;&nbsp;[前序决策已无损注入] · 绝不破坏 tool_use 与 tool_result 紧邻性...
          </div>
        </div>

        {/* 场景 3 */}
        <div style={{ position: 'absolute', inset: 0, opacity: scene3Opacity, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ padding: '3px 8px', background: 'rgba(46,160,67,0.2)', border: '1px solid #2ea043', borderRadius: '6px', fontSize: '12px', color: '#3fb950', fontWeight: 600 }}>
                ✔ 【跨模型接棒成功】
              </span>
              <span style={{ fontSize: '12px', color: '#8b949e' }}>接手模型：GLM-5.3-Flash 正在高速输出</span>
            </div>
            <div style={{ fontSize: '11px', color: '#3fb950' }}>首字延迟 (TTFT) 极速</div>
          </div>
          <div style={{ padding: '14px', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px', fontFamily: 'monospace', fontSize: '12px', lineHeight: '20px', color: '#e6edf3' }}>
            <span style={{ color: '#7ee787' }}>// GLM-5.3-Flash 无缝继承前序架构决策，直接产出实现代码</span><br/>
            <span style={{ color: '#ff7b72' }}>export class</span> <span style={{ color: '#ffa657' }}>TokenManager</span> &#123;<br/>
            &nbsp;&nbsp;<span style={{ color: '#d2a8ff' }}>private</span> redis: RedisClient;<br/>
            &nbsp;&nbsp;<span style={{ color: '#79c0ff' }}>async</span> refreshSession(token: <span style={{ color: '#79c0ff' }}>string</span>) &#123; ... &#125;<br/>
            &#125;
          </div>
        </div>
      </div>
    </div>
  );
};
