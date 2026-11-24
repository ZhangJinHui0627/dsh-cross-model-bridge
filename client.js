/**
 * dsh-cross-model-bridge - browser half (v2.1.0 工业级重构版).
 *
 * Registers "跨模型桥" as a conversation view & right-Sidebar tab:
 *   1. the view      -> ctx.slots.inject('conversation.view', ...)
 *   2. the type      -> ctx.sidebarRightTabs.register(...)
 *   3. the body      -> keyed 'sidebar.right.pane.tab' slot
 *   4. the title     -> keyed 'sidebar.right.pane.tab.title' chip
 *
 * Data comes from host GET /plugins/dsh-cross-model-bridge/events(?sessionId=...)
 * Features:
 *   - 三段式结构化抽取展示（首部目标 + 决策锚点 + 收敛尾部）；
 *   - Prompt Cache 友好提示与 Token 预算监控；
 *   - 物理绝对吸顶状态栏、一键回顶、会话隔离与防丢持久化。
 */

window.__ModuleLoader__.load({
  id: "dsh-cross-model-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState, useCallback } = React;

    const ID = "dsh-cross-model-bridge";
    const KIND = "cross-model-bridge";
    const EVENTS_URL = "/plugins/dsh-cross-model-bridge/events";
    const POLL_MS = 4000;

    function fmtTime(iso) {
      try {
        var d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (e) { return String(iso); }
    }

    function fmtChars(n) {
      if (!n) return "0 字";
      if (n >= 10000) return (n / 1000).toFixed(1) + "k 字";
      return n + " 字";
    }

    /** 标题 chip：图标 + 固定文案。 */
    function BridgeTitle() {
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: "5px" } },
        h("svg", { width: "13", height: "13", viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
          h("path", { d: "M3 10h4l2-5 2 10 2-5h4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" })
        ),
        "跨模型桥"
      );
    }

    /** 顶部状态卡：含一键回顶、刷新与对话范围切换。 */
    function StatusCard(state, onScrollTop, onRefresh, scopeMode, onToggleScope) {
      var on = state.enabled === true;
      var isSession = scopeMode === "session";
      return h("div", {
        style: {
          display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
          padding: "8px 12px",
          borderRadius: "8px",
          background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
          border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
          boxShadow: "0 2px 6px rgba(0,0,0,.04)",
          fontSize: "12px", lineHeight: "18px",
        },
      },
        h("span", { title: on ? "桥接已启用" : "桥接已停用" },
          h("span", {
            style: {
              display: "inline-block", width: "8px", height: "8px", borderRadius: "50%",
              marginRight: "6px",
              background: on ? "var(--dsw-alias-state-success-primary, #2da44e)" : "var(--dsw-alias-state-error-primary, #c62828)",
            },
          }),
          on ? "已启用" : "已停用"
        ),
        h("span", {
          style: {
            padding: "1px 6px", borderRadius: "4px", fontSize: "11px",
            background: "rgba(9, 105, 218, 0.1)", color: "var(--dsw-alias-state-business-primary, #0969da)",
            fontWeight: 500,
          },
        }, "v" + (state.version || "2.1.0") + " 三段式智能接力"),
        h("span", {
          title: "三段式预算：15% 初始目标 + 25% 关键决策锚点 + 60% 收敛尾部",
          style: { color: "var(--dsw-alias-label-secondary, #555)" },
        }, "预算 " + String(state.maxThinkingTokens || 500) + " Token"),
        h("span", {
          style: {
            fontSize: "11px", padding: "1px 5px", borderRadius: "3px",
            background: "rgba(45, 164, 78, 0.1)", color: "#1a7f37",
          },
          title: "不改写顶层 System 消息，100% 保持厂商原生 KV Cache 前缀命中",
        }, "⚡ KV Cache 保护"),
        h("div", { style: { marginLeft: "auto", display: "inline-flex", gap: "6px", alignItems: "center" } },
          h("button", {
            type: "button",
            onClick: onToggleScope,
            style: {
              fontSize: "11px", padding: "2px 8px", cursor: "pointer", borderRadius: "4px",
              border: "1px solid " + (isSession ? "var(--dsw-alias-state-business-primary, #0969da)" : "var(--dsw-alias-border-l1, rgba(127,127,127,.25))"),
              background: isSession ? "var(--dsw-alias-state-business-primary, #0969da)" : "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
              color: isSession ? "#ffffff" : "var(--dsw-alias-label-primary, inherit)",
              fontWeight: 500,
            },
            title: isSession ? "当前仅显示本对话的数据，点击可切换为查看全部对话" : "当前显示全部对话的数据，点击可切回仅本对话",
          }, isSession ? "当前对话" : "全部对话"),
          h("button", {
            type: "button",
            onClick: onScrollTop,
            style: {
              fontSize: "11px", padding: "2px 8px", cursor: "pointer", borderRadius: "4px",
              border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
              background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
              color: "var(--dsw-alias-label-primary, inherit)",
            },
            title: "一键返回最上方查看最新消息",
          }, "↑ 顶部最新"),
          h("button", {
            type: "button",
            onClick: onRefresh,
            style: {
              fontSize: "11px", padding: "2px 8px", cursor: "pointer", borderRadius: "4px",
              border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
              background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
              color: "var(--dsw-alias-label-primary, inherit)",
            },
          }, "刷新")
        )
      );
    }

    /** 单条桥接事件行：展示三段式抽取详情、接棒类型与路由。 */
    function EventRow(ev) {
      var isAccount = ev.kind === "account" || ev.mode === "cross-account" || (ev.tag && ev.tag.indexOf("账号") !== -1);
      var badgeBg = isAccount ? "rgba(45, 164, 78, 0.12)" : "rgba(9, 105, 218, 0.12)";
      var badgeColor = isAccount ? "#1a7f37" : "#0969da";
      var badgeText = ev.tag || (isAccount ? "【跨账号接棒】" : "【跨模型接棒】");

      var ext = ev.extraction;
      var extText = "";
      if (ext && ext.isTruncated) {
        extText = "🎯 首部 " + ext.headChars + "字 · 📍 锚点 " + ext.anchorCount + "项 · 🏁 尾部 " + ext.tailChars + "字";
      } else if (ext && !ext.isTruncated) {
        extText = "✨ 思考未超预算，完整保留 (" + ext.totalTokens + " Token)";
      }

      return h("div", {
        key: ev.time + ev.target + (ev.sessionId || ""),
        style: {
          padding: "9px 12px", marginBottom: "8px",
          borderRadius: "8px",
          background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))",
          border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))",
          fontSize: "12px", lineHeight: "18px",
        },
      },
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px", flexWrap: "wrap" } },
          h("span", {
            style: {
              fontSize: "11px", padding: "1px 6px", borderRadius: "4px",
              background: badgeBg, color: badgeColor, fontWeight: 600,
            },
          }, badgeText),
          h("span", {
            style: { color: "var(--dsw-alias-label-tertiary, #888)", fontVariantNumeric: "tabular-nums" },
            title: ev.time,
          }, fmtTime(ev.time)),
          ev.hasEvidence
            ? h("span", {
                style: {
                  fontSize: "11px", padding: "1px 5px", borderRadius: "3px",
                  background: "rgba(130, 80, 223, 0.1)", color: "#8250df",
                },
                title: "通过三段式结构化抽取提取关键推演与决策锚点",
              }, "🧠 三段式证据 (" + (ev.estimatedTokens || "~") + " Token)")
            : h("span", {
                style: {
                  fontSize: "11px", padding: "1px 5px", borderRadius: "3px",
                  background: "rgba(127, 127, 127, 0.1)", color: "var(--dsw-alias-label-tertiary, #888)",
                },
                title: "前序无深度推演块，直接进行纯任务上下文交接",
              }, "📋 纯任务交接"),
          h("span", {
            style: {
              marginLeft: "auto", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "260px",
            },
            title: "接手目标 " + ev.target,
          }, "→ " + ev.target)
        ),
        h("div", { style: { color: "var(--dsw-alias-label-secondary, #666)", marginBottom: "3px" } },
          (ev.sources || []).map(function (s) { return "← 来源: " + s; }).join("　")
        ),
        extText
          ? h("div", {
              style: {
                fontSize: "11px", color: "var(--dsw-alias-state-business-primary, #0969da)",
                background: "rgba(9, 105, 218, 0.05)", padding: "2px 6px", borderRadius: "4px",
                marginBottom: "3px", display: "inline-block",
              },
            }, extText)
          : null,
        h("div", { style: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "11px" } },
          "扫描 " + ev.messages + " 条历史 · 注入协议与证据 " + fmtChars(ev.injectedChars)
          + (ev.strippedMessages > 0 ? " · 剥离旧 reasoning 签名 " + ev.strippedMessages + " 条" : "")
        )
      );
    }

    /** 页面主体：支持会话隔离 + 物理冻结顶部状态栏 + 事件独立滚动。 */
    function BridgeBody(props) {
      var currentSessionId = props && typeof props.useSession === "function"
        ? props.useSession(function (s) { return s ? s.sessionId : null; })
        : null;

      var [scopeMode, setScopeMode] = useState("session"); // "session" | "all"
      var [data, setData] = useState({
        enabled: true,
        version: "2.1.0",
        mode: "smart-handoff-v2",
        maxThinkingTokens: 500,
        lang: "zh",
        events: [],
        totalEvents: 0,
      });

      var listRef = useRef(null);

      var scrollToTop = useCallback(function (smooth) {
        if (listRef.current) {
          if (smooth) {
            listRef.current.scrollTo({ top: 0, behavior: "smooth" });
          } else {
            listRef.current.scrollTop = 0;
          }
        }
      }, []);

      var fetchEvents = useCallback(function () {
        var sid = (scopeMode === "session" && currentSessionId) ? currentSessionId : "";
        var url = EVENTS_URL + (sid ? "?sessionId=" + encodeURIComponent(sid) : "");
        fetch(url, { headers: { accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && typeof j === "object") setData(j);
          })
          .catch(function () {});
      }, [scopeMode, currentSessionId]);

      useEffect(function () {
        fetchEvents();
        scrollToTop(false);
        var timer = setInterval(fetchEvents, POLL_MS);
        return function () { clearInterval(timer); };
      }, [fetchEvents, scrollToTop]);

      var events = (data.events || []).slice().reverse();
      var totalInjected = (data.events || []).reduce(function (a, e) { return a + (e.injectedChars || 0); }, 0);
      var isSession = scopeMode === "session";

      return h("div", {
        "data-cross-model-bridge": "",
        "data-conversation-composer-overlay": "",
        style: {
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          boxSizing: "border-box",
          position: "relative",
          background: "var(--dsw-alias-bg-base, #ffffff)",
        },
      },
        // 1. 物理绝对固定的顶部状态栏（不参与任何滚动）
        h("div", {
          style: {
            flex: "none",
            padding: "12px 16px 8px 16px",
            background: "var(--dsw-alias-bg-base, #ffffff)",
            borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))",
            zIndex: 10,
          },
        },
          StatusCard(
            data,
            function () { scrollToTop(true); },
            fetchEvents,
            scopeMode,
            function () { setScopeMode(isSession ? "all" : "session"); }
          ),
          h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #888)", margin: "6px 2px 0" } },
            (isSession ? "【当前对话】" : "【全部对话】") +
            " 共 " + events.length + " 次接力 · 累计注入 " + fmtChars(totalInjected) +
            (data.totalEvents && isSession ? "（总计 " + data.totalEvents + " 次，最近 4s 自动刷新）" : "（最近 4s 自动刷新）")
          )
        ),
        // 2. 独立滚动的事件区域（仅此处滚动）
        h("div", {
          ref: listRef,
          style: {
            flex: "1 1 0",
            minHeight: 0,
            overflowY: "auto",
            padding: "8px 16px calc(var(--dsh-composer-height, 120px) + 24px) 16px",
          },
        },
          events.length === 0
            ? h("div", {
                style: { color: "var(--dsw-alias-label-tertiary, #888)", padding: "32px 16px", textAlign: "center", fontSize: "12px", lineHeight: "22px" },
              },
                isSession ? "当前对话暂无跨模型/跨账号接力记录" : "暂无接力记录",
                h("br", null),
                isSession
                  ? "当额度耗尽切换账号，或切换到不同模型时，插件将自动激活三段式智能接棒导航并在此记录。"
                  : "在会话中进行模型或账号交接后，此处将实时展示结构化接力详情。"
              )
            : events.map(EventRow)
        )
      );
    }

    var inject = ["slots"];

    function apply(ctx) {
      // 1) 会话主视图（顶部导航栏 与 ... 溢出菜单）
      ctx.effect(function () {
        return ctx.slots.inject("conversation.view", function () {
          return ctx.slots.register({
            name: "conversation.view",
            id: ID,
            order: 25,
            label: function () { return "跨模型桥"; },
          }, BridgeBody);
        });
      }, "cross-model-bridge: conversation view");

      // 2) 右侧栏 tab 类型
      ctx.inject(["sidebarRightTabs"], function (scope) {
        var tabs = scope && typeof scope.get === "function" ? scope.get("sidebarRightTabs") : scope;
        if (!tabs || typeof tabs.register !== "function") return;
        ctx.effect(function () {
          return tabs.register({
            id: ID,
            kind: KIND,
            priority: "extension",
            title: function () { return "跨模型桥"; },
            guide: [{
              id: "bridge-page",
              order: 50,
              title: function () { return "跨模型桥"; },
              description: function () { return "查看跨模型思考桥接的实时记录"; },
            }],
          });
        }, "cross-model-bridge: tab type");
      });

      // 3) 右侧栏 body：键控 sidebar.right.pane.tab，key = 类型 id
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID }, BridgeBody);
        });
      }, "cross-model-bridge: tab body");

      // 4) 右侧栏 title chip
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: ID }, BridgeTitle);
        });
      }, "cross-model-bridge: tab title");
    }

    exports.name = ID;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
