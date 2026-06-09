/**
 * pi-token-stats
 *
 * Live per-turn token breakdown by category in the footer.
 * Run /token-stats to open the interactive overlay with drill-down.
 *
 * Footer: ↑4.1k sys:87 sk:355 tl:2.8k hi:0 tr:0 in:42 | ↓312
 * Overlay: stacked bar + per-category table → Enter to view raw content
 *
 * Install:
 *   cp -r pi-token-stats ~/.pi/agent/extensions/
 *   cd ~/.pi/agent/extensions/pi-token-stats && npm install
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CategoryStats {
  base: number;      // system prompt base instructions
  skills: number;    // <available_skills> block
  metadata: number;  // date / cwd footer lines
  tools: number;     // active tool JSON schemas
  history: number;   // past user + assistant messages
  results: number;   // tool result messages in context
  input: number;     // current user message (this turn)
}

interface MsgSnapshot {
  role: string;
  text: string;
  toolName?: string;
  category: "history" | "results" | "input";
  tokens: number;
}

interface TurnRecord {
  turnIndex: number;
  timestamp: number;
  estimated: CategoryStats;
  actual: { in: number | null; out: number | null; cacheR: number; cacheW: number; cost: number; savings: number } | null;
  content: {
    systemPrompt: string;
    toolsJson: string;
    messages: MsgSnapshot[];
  };
}

// ─── Token helpers ──────────────────────────────────────────────────────────────

let cachedSysPrompt = "";
let cachedParsedSys: ReturnType<typeof parseSystemPrompt> | null = null;
let cachedToolsStr = "";
let cachedToolsTok = 0;

function tok(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: Date.now() });
}

function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .map((b) =>
        b?.type === "text"        ? (b.text ?? "") :
        b?.type === "toolCall"    ? `${b.name} ${typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {})}` :
        b?.type === "thinking"    ? (b.thinking ?? "") :
        b?.type === "image"       ? " 0".repeat(400) :
        b?.type === "tool_result" ? extractText(b.content) :
        b?.text ?? (typeof b?.content === "object" ? JSON.stringify(b.content) : b?.content) ?? ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function parseSystemPrompt(prompt: string) {
  if (!prompt) return { base: 0, skills: 0, metadata: 0, baseText: "", skillsText: "", metaText: "" };

  const skillsMatch = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/g);
  const skillsText  = skillsMatch ? skillsMatch.join("\n") : "";

  const metaPat   = /Current (?:date|time|working directory)[^\n]*\n?/gi;
  const metaLinesMatch = prompt.match(metaPat) ?? [];
  const metaText  = metaLinesMatch.join("").trim();

  let baseText = prompt;
  if (skillsMatch) {
    for (const match of skillsMatch) {
      baseText = baseText.replace(match, "");
    }
  }
  baseText = baseText.replace(metaPat, "");
  baseText = baseText.trim();

  return { base: tok(baseText), skills: tok(skillsText), metadata: tok(metaText),
           baseText, skillsText, metaText };
}

function extractMessageText(msg: any): string {
  if (msg.role === "bashExecution") {
    return (msg.command ?? "") + "\n" + (msg.output ?? "");
  }
  if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
    return msg.summary ?? "";
  }
  return extractText(msg.content);
}

// ─── Display helpers ────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function fmtCost(c: number): string {
  if (c === 0) return "$0.00";
  return `$${c.toFixed(4)}`;
}

function totalEst(e: CategoryStats): number {
  return e.base + e.skills + e.metadata + e.tools + e.history + e.results + e.input;
}

// Sorted by descending token count for the table; bar order is fixed
const CATS: Array<{ key: keyof CategoryStats; label: string; legendLabel: string; color: string }> = [
  { key: "tools",    label: "Tool definitions",  legendLabel: "Tools",    color: "error"   },
  { key: "history",  label: "History",           legendLabel: "History",  color: "success" },
  { key: "results",  label: "Tool results",      legendLabel: "Results",  color: "text"    },
  { key: "metadata", label: "Metadata",          legendLabel: "Meta",     color: "accent"  },
  { key: "skills",   label: "Skills",            legendLabel: "Skills",   color: "mdLink"  },
  { key: "base",     label: "System (base)",     legendLabel: "System",   color: "muted"   },
  { key: "input",    label: "User message",      legendLabel: "Input",    color: "dim"     },
];

// ─── Overlay component ──────────────────────────────────────────────────────────

function makeOverlay(
  history: TurnRecord[],
  ctx: any,
  tui: any,
  theme: any,
  done: (v: void) => void,
) {
  let turnIdx  = history.length - 1;
  let inDrill  = false;
  let viewMode : "turn" | "session" = "turn";
  let scrollY  = 0;
  let drillLines: string[] = [];

  // Sort categories by token count for the current turn
  function sortedCats(e: CategoryStats) {
    return [...CATS].sort((a, b) => e[b.key] - e[a.key]);
  }

  let selKey: keyof CategoryStats = sortedCats(history[turnIdx].estimated)[0].key;

  function buildDrillLines(rec: TurnRecord): string[] {
    const cat = CATS.find(c => c.key === selKey)!;
    const parsed = parseSystemPrompt(rec.content.systemPrompt);
    let raw = "";

    switch (cat.key) {
      case "base":     raw = parsed.baseText || "(empty)"; break;
      case "skills":
        if (!parsed.skillsText) {
          raw = "(no <available_skills> block found)";
        } else {
          const skillMatches = parsed.skillsText.match(/<skill>[\s\S]*?<\/skill>/g);
          if (skillMatches && skillMatches.length > 0) {
            raw = skillMatches
              .map(s => {
                const nameMatch = s.match(/<name>(.*?)<\/name>/);
                const name = nameMatch ? nameMatch[1] : "unknown";
                return `── [skill: ${name}] (${fmt(tok(s))} tokens) ──────────────────────────────\n${s}`;
              })
              .join("\n\n");
          } else {
            raw = parsed.skillsText;
          }
        }
        break;
      case "metadata": raw = parsed.metaText || "(no metadata found)"; break;
      case "tools":
        if (!rec.content.toolsJson) {
          raw = "(no tools)";
        } else {
          try {
            const toolsArr = JSON.parse(rec.content.toolsJson);
            if (Array.isArray(toolsArr)) {
              raw = toolsArr
                .map(t => {
                  const tStr = JSON.stringify(t, null, 2);
                  return `── [tool: ${t.name || "unknown"}] (${fmt(tok(tStr))} tokens) ──────────────────────────────\n${tStr}`;
                })
                .join("\n\n");
            } else {
              raw = rec.content.toolsJson;
            }
          } catch (e) {
            raw = rec.content.toolsJson;
          }
        }
        break;
      case "history":
        raw = rec.content.messages
          .filter(m => m.category === "history")
          .map(m => `── [${m.role}] (${fmt(m.tokens)} tokens) ──────────────────────────────\n${m.text}`)
          .join("\n\n") || "(no conversation history)";
        break;
      case "results":
        raw = rec.content.messages
          .filter(m => m.category === "results")
          .map(m => `── [tool: ${m.toolName ?? "unknown"}] (${fmt(m.tokens)} tokens) ──────────────────────────────\n${m.text}`)
          .join("\n\n") || "(no tool results in context)";
        break;
      case "input":
        raw = rec.content.messages.find(m => m.category === "input")?.text ?? "(no user message captured)";
        break;
    }

    const lines = raw.split("\n");
    const wrapped: string[] = [];
    const wrapWidth = 86;
    for (const l of lines) {
      if (l.startsWith("── [") || l.length <= wrapWidth) {
        wrapped.push(l);
      } else {
        let current = l;
        while (current.length > wrapWidth) {
          let breakIdx = current.lastIndexOf(" ", wrapWidth);
          if (breakIdx === -1) breakIdx = wrapWidth;
          wrapped.push(current.substring(0, breakIdx));
          current = current.substring(breakIdx).trimStart();
        }
        if (current) wrapped.push(current);
      }
    }

    return wrapped;
  }

  const DRILL_VISIBLE = 30;

  return {
    render(width: number): string[] {
      const rec  = history[turnIdx];
      const e    = rec.estimated;
      const tot  = totalEst(e);
      const out: string[] = [];

      if (viewMode === "session") {
        const title = theme.bold(" Session Summary ");
        out.push(`${title}  ${theme.fg("muted", "(Tab to switch view)")}`);
        out.push("");

        let totalCost = 0, totalSavings = 0, totalCacheR = 0, totalCacheW = 0, totalIn = 0, totalOut = 0;
        let mostExpensiveTurn = -1, maxTurnCost = -1;
        
        // Calculate actual cost dynamically from the history array
        // which retains all turns even after Pi compacts the sessionManager
        for (const h of history) {
          if (h.actual) {
            totalSavings += h.actual.savings;
            totalCacheR += h.actual.cacheR;
            totalCacheW += h.actual.cacheW;
            totalIn += h.actual.in ?? 0;
            totalOut += h.actual.out ?? 0;
            totalCost += h.actual.cost ?? 0;
            if (h.actual.cost > maxTurnCost) {
              maxTurnCost = h.actual.cost;
              mostExpensiveTurn = h.turnIndex;
            }
          }
        }

        const avgCost = history.length > 0 ? totalCost / history.length : 0;
        const totalProcessed = totalIn + totalCacheR + totalCacheW;
        const cacheHitRate = totalProcessed > 0 ? (totalCacheR / totalProcessed) * 100 : 0;

        out.push(`  ${theme.fg("mdLink", "Total Turns")}    ${history.length}`);
        out.push(`  ${theme.fg("mdLink", "Total Prompt")}   ↑ ${fmt(totalProcessed)} tokens`);
        out.push(`  ${theme.fg("mdLink", "Uncached In")}    ↑ ${fmt(totalIn)} tokens`);
        out.push(`  ${theme.fg("mdLink", "Total Output")}   ↓ ${fmt(totalOut)} tokens`);
        out.push(`  ${theme.fg("mdLink", "Total Cost")}     ${theme.fg("success", fmtCost(totalCost))}`);
        out.push(`  ${theme.fg("mdLink", "Avg Turn Cost")}  ${fmtCost(avgCost)}`);
        if (maxTurnCost >= 0 && mostExpensiveTurn >= 0) {
          out.push(`  ${theme.fg("mdLink", "Peak Turn")}      T${mostExpensiveTurn + 1} (${theme.fg("error", fmtCost(maxTurnCost))})`);
        }
        out.push("");
        out.push(`  ${theme.fg("accent", "Cache Hits")}     ${fmt(totalCacheR)} tokens (${cacheHitRate.toFixed(1)}%)`);
        out.push(`  ${theme.fg("success", "Cache Savings")}  ${fmtCost(totalSavings)}`);

        out.push("");
        out.push(theme.fg("muted", "  Tab: switch view   Esc: close"));
      } else if (!inDrill) {
        // ── Header ────────────────────────────────────────────
        const title   = theme.bold(" Turn Detail ");
        const turnNav = theme.fg("muted", `T${turnIdx + 1}/${history.length}  ← → switch  Home/End jump  Tab summary`);
        out.push(`${title} ${turnNav}`);
        out.push("");

        // ── Actual vs estimated ────────────────────────────────
        const activeModel = ctx.getModel?.();
        const ctxWindow = activeModel?.contextWindow;
        
        let ctxInfo = "";
        if (ctxWindow) {
          const usedTokens = rec.actual?.in != null ? (rec.actual.in + (rec.actual.cacheR ?? 0) + (rec.actual.cacheW ?? 0)) : tot;
          const pct = Math.min(100, (usedTokens / ctxWindow) * 100).toFixed(1);
          const pctColor = Number(pct) > 90 ? "error" : Number(pct) > 75 ? "accent" : "muted";
          ctxInfo = `  ${theme.fg("muted", "Context")}   ${theme.fg(pctColor, `${pct}%`)} of ${fmt(ctxWindow)}`;
        }

        if (rec.actual) {
          const ai = rec.actual.in;
          const ao = rec.actual.out;
          const { cacheR, cacheW, cost } = rec.actual;
          const inStr = ai != null ? fmt(ai) : `~${fmt(tot)}`;
          const outStr = ao != null ? fmt(ao) : "??";
          const costStr = cost > 0 ? `  cost ${theme.fg("success", fmtCost(cost))}` : "";
          out.push(`  ${theme.fg("mdLink", "Actual")}    ↑ ${inStr}  ↓ ${outStr}  cache_r ${fmt(cacheR)}  cache_w ${fmt(cacheW)}${costStr}`);
        } else {
          out.push(`  ${theme.fg("muted", "Actual")}    (not captured — provider may not expose per-call usage)`);
        }
        
        const estLine = `  ${theme.fg("muted", "Estimated")} ↑ ~${fmt(tot)} total`;
        out.push(ctxInfo ? `${estLine.padEnd(50)}${ctxInfo}` : estLine);
        out.push("");

        // ── Stacked bar ────────────────────────────────────────
        const bw = Math.max(10, width - 6);
        let bar = "  ";
        for (const { key, color } of CATS) {
          const w = tot > 0 ? Math.round((e[key] / tot) * bw) : 0;
          if (w > 0) bar += theme.fg(color, "█".repeat(w));
        }
        out.push(bar);

        // ── Legend ─────────────────────────────────────────────
        const legend = CATS.map(c =>
          e[c.key] > 0 ? theme.fg(c.color, `■ ${c.legendLabel}`) : ""
        ).filter(Boolean).join("  ");
        out.push("  " + legend);
        out.push("");

        // ── Category table (sorted by tokens desc) ─────────────
        const sorted = sortedCats(e);
        out.push(`  ${"Category".padEnd(24)} ${"Tokens".padStart(8)}   ${"  %"}`);
        out.push("  " + "─".repeat(Math.min(width - 6, 48)));

        for (let i = 0; i < sorted.length; i++) {
          const { key, label, color } = sorted[i];
          const n   = e[key];
          const pct = tot > 0 ? ((n / tot) * 100).toFixed(1) : "0.0";
          const sel = selKey === key; // highlight selected regardless of sort
          const marker = sel ? theme.fg("accent", "▶ ") : "  ";
          const paddedLabel = label.padEnd(24);
          const lbl    = sel ? theme.bold(theme.fg(color, paddedLabel)) : theme.fg(color, paddedLabel);
          out.push(`${marker}${lbl}${fmt(n).padStart(8)} tok  ${pct.padStart(5)}%`);
        }

        out.push("");
        out.push(theme.fg("muted", "  ↑↓: select   Enter: view   ← →: turns   Tab: summary   Esc: close"));
      } else {
        // ── Drill-down ─────────────────────────────────────────
        const cat = CATS.find(c => c.key === selKey)!;
        const catTok = rec.estimated[cat.key];
        out.push(
          theme.bold(` ▶ ${cat.label}`) +
          theme.fg("muted", `  ${fmt(catTok)} tok`) +
          theme.fg("muted", "   ↑↓: scroll   Esc: back")
        );
        out.push("");

        const visible = drillLines.slice(scrollY, scrollY + DRILL_VISIBLE);
        for (const l of visible) {
          // Dim continuation lines, highlight section headers
          if (l.startsWith("── [")) out.push(theme.fg("accent", "  " + l));
          else out.push("  " + theme.fg("dim", l));
        }

        // Pad if fewer lines than visible area
        for (let i = visible.length; i < DRILL_VISIBLE; i++) out.push("");

        out.push("");
        out.push(theme.fg("muted",
          `  Lines ${scrollY + 1}–${Math.min(scrollY + DRILL_VISIBLE, drillLines.length)} / ${drillLines.length}   PgUp/PgDn: jump`
        ));
      }

      return out;
    },

    invalidate() {},

    handleInput(data: string) {
      if (matchesKey(data, "tab")) {
        viewMode = viewMode === "session" ? "turn" : "session";
        tui.requestRender();
        return;
      }

      if (viewMode === "session") {
        if (matchesKey(data, "escape") || data === "q" || data === "Q") done(undefined);
        return;
      }

      if (!inDrill) {
        const sorted = sortedCats(history[turnIdx].estimated);
        let idx = sorted.findIndex(c => c.key === selKey);
        if (idx === -1) idx = 0;

        if (matchesKey(data, "up")) {
          selKey = sorted[(idx - 1 + sorted.length) % sorted.length].key;
        } else if (matchesKey(data, "down")) {
          selKey = sorted[(idx + 1) % sorted.length].key;
        } else if (matchesKey(data, "left")) {
          turnIdx = Math.max(0, turnIdx - 1);
        } else if (matchesKey(data, "right")) {
          turnIdx = Math.min(history.length - 1, turnIdx + 1);
        } else if (matchesKey(data, "home")) {
          turnIdx = 0;
        } else if (matchesKey(data, "end")) {
          turnIdx = history.length - 1;
        } else if (data === "\r" || data === "\n") {
          drillLines = buildDrillLines(history[turnIdx]);
          inDrill    = true;
          scrollY    = 0;
        } else if (matchesKey(data, "escape") || data === "q" || data === "Q") {
          done(undefined);
          return;
        } else if (data === "e" || data === "E") {
          exportStats(history, ctx, done);
          return;
        }
      } else {
        if (matchesKey(data, "up")) {
          scrollY = Math.max(0, scrollY - 1);
        } else if (matchesKey(data, "down")) {
          const maxScroll = Math.max(0, drillLines.length - DRILL_VISIBLE);
          scrollY = Math.min(maxScroll, scrollY + 1);
        } else if (data === "d" || data === "\x04" || matchesKey(data, "pageDown")) { // d / ctrl+d / page down
          const maxScroll = Math.max(0, drillLines.length - DRILL_VISIBLE);
          scrollY = Math.min(maxScroll, scrollY + 15);
        } else if (data === "u" || data === "\x15" || matchesKey(data, "pageUp")) { // u / ctrl+u / page up
          scrollY = Math.max(0, scrollY - 15);
        } else if (matchesKey(data, "escape") || data === "q" || data === "Q") {
          inDrill = false;
          scrollY = 0;
        } else if (data === "e" || data === "E") {
          exportStats(history, ctx, done);
          return;
        }
      }
      tui.requestRender();
    },
  };
}

function exportStats(history: TurnRecord[], ctx: any, done: (v: void) => void) {
  done(undefined);
  setTimeout(() => {
    Promise.all([import("fs/promises"), import("path")]).then(async ([fs, path]) => {
      const filename = `pi-token-stats-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const exportPath = path.join(process.cwd(), filename);
      
      const exportData = {
        exportedAt: new Date().toISOString(),
        turns: history
      };
      
      try {
        await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), "utf8");
        ctx.ui.notify(`Exported token stats to ${exportPath}`, "success");
      } catch (err: any) {
        ctx.ui.notify(`Failed to export token stats: ${err?.message}`, "error");
      }
    });
  }, 10);
}

// ─── Extension entry ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const turns: TurnRecord[]      = [];
  let pending: Partial<TurnRecord> | null = null;
  let inputTok = -1, outputTok = -1, cacheR = -1, cacheW = -1, turnCost = 0, turnSavings = 0;
  let cum = { base: 0, skills: 0, tools: 0, history: 0, results: 0, input: 0, totalIn: 0, totalOut: 0, cacheR: 0, cacheW: 0, cost: 0, savings: 0 };
  let hasWarned80 = false;
  let hasWarned90 = false;
  let lastContextTokens = 0;

  const msgCache = new WeakMap<any, { text: string; tok: number }>();

  // ── Turn lifecycle ────────────────────────────────────────────────────────────

  pi.on("turn_start", (event, _ctx) => {
    pending = { turnIndex: event.turnIndex, timestamp: Date.now(), actual: null };
    inputTok = outputTok = cacheR = cacheW = -1;
    turnCost = 0;
    turnSavings = 0;
  });

  pi.on("context", (event, ctx) => {
    if (!pending) return;

    const systemPrompt = ctx.getSystemPrompt();
    if (systemPrompt !== cachedSysPrompt || !cachedParsedSys) {
      cachedSysPrompt = systemPrompt;
      cachedParsedSys = parseSystemPrompt(systemPrompt);
    }
    const parsed = cachedParsedSys;

    // Tool tokens — schemas sent separately via the tools API param
    const activeTools = pi.getActiveTools();
    const toolsJson   = JSON.stringify(activeTools);
    if (toolsJson !== cachedToolsStr) {
      cachedToolsStr = toolsJson;
      cachedToolsTok = tok(activeTools.map(t => JSON.stringify(t, null, 2)).join("\n\n---\n\n"));
    }
    const toolsTok = cachedToolsTok;

    // Categorize messages in context
    const msgs: any[]           = (event as any).messages ?? [];
    const snapshots: MsgSnapshot[] = [];
    let histTok = 0, resTok = 0, inTok = 0;

    for (let i = 0; i < msgs.length; i++) {
      const msg  = msgs[i];
      if (msg.excludeFromContext) continue;
      
      let cached = msgCache.get(msg);
      if (!cached) {
        const text = extractMessageText(msg);
        cached = { text, tok: tok(text) };
        msgCache.set(msg, cached);
      }
      
      const text = cached.text;
      const t = cached.tok;

      if (msg.role === "toolResult") {
        resTok += t;
        snapshots.push({ role: "toolResult", text, toolName: msg.toolName ?? msg.name, category: "results", tokens: t });
      } else if (i === msgs.length - 1) {
        inTok = t;
        snapshots.push({ role: msg.role, text, category: "input", tokens: t });
      } else {
        histTok += t;
        snapshots.push({ role: msg.role, text, category: "history", tokens: t });
      }
    }

    pending.estimated = {
      base:     parsed.base,
      skills:   parsed.skills,
      metadata: parsed.metadata,
      tools:    toolsTok,
      history:  histTok,
      results:  resTok,
      input:    inTok,
    };
    pending.content = { systemPrompt, toolsJson, messages: snapshots };

    // Live stats below editor while LLM is responding
    const e   = pending.estimated;
    const tot = totalEst(e);
    const t   = ctx.ui.theme;
    
    let ctxPctStr = "";
    const ctxUsage = ctx.getContextUsage();
    if (ctxUsage?.percent != null) {
      const p = ctxUsage.percent;
      const pColor = p > 90 ? "error" : p > 75 ? "accent" : "muted";
      ctxPctStr = t.fg("muted", " | ") + t.fg(pColor, `${p.toFixed(1)}%`);

      if (ctxUsage.tokens != null) {
        lastContextTokens = ctxUsage.tokens;
      }
      
      if (p >= 90 && !hasWarned90) {
        ctx.ui.notify(`Context window critical: ${p.toFixed(1)}% full`, "error");
        hasWarned90 = true;
        hasWarned80 = true;
      } else if (p >= 80 && p < 90 && !hasWarned80) {
        ctx.ui.notify(`Context window warning: ${p.toFixed(1)}% full`, "info");
        hasWarned80 = true;
      }
    }
    
    const widgetText = t.fg("muted", "[") + t.fg("muted", `T${(pending.turnIndex ?? 0) + 1} `) + t.fg("dim", "↑") + t.fg("mdLink", fmt(tot)) + t.fg("muted", "]");
    ctx.ui.setWorkingMessage(`${widgetText} Working...`);
  });

  // Capture actual usage from provider stream events
  pi.on("message_update", (event, _ctx) => {
    const se = (event as any).assistantMessageEvent;
    if (!se) return;
    
    let tuiUpdateNeeded = false;
    const usage = se.type === "done" ? se.message?.usage : se.partial?.usage;
    if (usage) {
      if (usage.input !== undefined) {
        if (inputTok !== usage.input) tuiUpdateNeeded = true;
        inputTok = usage.input;
      }
      if (usage.output !== undefined) {
        if (outputTok !== usage.output) tuiUpdateNeeded = true;
        outputTok = usage.output;
      }
      if (usage.cacheRead !== undefined) cacheR = usage.cacheRead;
      if (usage.cacheWrite !== undefined) cacheW = usage.cacheWrite;
      if (usage.cost?.total !== undefined) turnCost = usage.cost.total;
      
      const model = (_ctx as any).getModel?.();
      if (model?.cost && cacheR > 0) {
        turnSavings = (cacheR / 1000000) * (model.cost.input - (model.cost.cacheRead ?? 0));
      }
      
      // Update UI if we are receiving live tokens
      if (tuiUpdateNeeded && _ctx.hasUI && pending?.estimated) {
        const e   = pending.estimated;
        const tot = totalEst(e);
        const t   = _ctx.ui.theme;
        
        const currentIn = inputTok >= 0 ? inputTok : tot;
        const currentOut = outputTok >= 0 ? outputTok : 0;
        
        let ctxPctStr = "";
        const ctxUsage = _ctx.getContextUsage();
        if (ctxUsage?.percent != null) {
          const p = ctxUsage.percent;
          const pColor = p > 90 ? "error" : p > 75 ? "accent" : "muted";
          
          let ctxDisplay = `${p.toFixed(1)}%`;
          const limit = (ctxUsage as any).contextWindow ?? (ctxUsage as any).limit;
          if (limit != null) {
            const limitStr = limit >= 1000000 
              ? `${(limit / 1000000).toFixed(1)}M` 
              : `${Math.round(limit / 1000)}k`;
            ctxDisplay += `/${limitStr}`;
          }
          ctxPctStr = t.fg(pColor, ctxDisplay);

          if (ctxUsage.tokens != null) {
            lastContextTokens = ctxUsage.tokens;
          }

          // In message_update, output streams quickly. Avoid spamming context warnings
          // by relying solely on the stable hasWarned flags across the turn.
          if (p >= 90 && !hasWarned90) {
            _ctx.ui.notify(`Context window critical: ${p.toFixed(1)}% full`, "error");
            hasWarned90 = true;
            hasWarned80 = true; // prevent the 80% from double-firing
          } else if (p >= 80 && p < 90 && !hasWarned80) {
            _ctx.ui.notify(`Context window warning: ${p.toFixed(1)}% full`, "info");
            hasWarned80 = true;
          }
        }
        
        const widgetText = t.fg("muted", "[") + t.fg("muted", `T${(pending.turnIndex ?? 0) + 1} `) + t.fg("dim", "↑") + t.fg("mdLink", fmt(currentIn)) + t.fg("muted", "]");
        _ctx.ui.setWorkingMessage(`${widgetText} Working...`);
      }
    }
  });

  pi.on("turn_end", (_event: any, ctx) => {
    if (!pending?.estimated || !pending?.content) { pending = null; return; }

    // Add messages and tool results generated during this turn to the final breakdown content
    // We do NOT add their tokens to pending.estimated because they are outputs of this turn,
    // not inputs. They will correctly become part of the input estimate on the NEXT turn's context event.
    const astMsg = _event.message;
    if (astMsg) {
      let text = extractMessageText(astMsg);
      if (astMsg.toolCalls && Array.isArray(astMsg.toolCalls)) {
        text += "\n" + astMsg.toolCalls.map((tc: any) => JSON.stringify(tc)).join("\n");
      }
      if (text.trim()) {
        const t = tok(text);
        pending.content.messages.push({ role: "assistant", text, category: "history", tokens: t });
      }
    }

    const trs = _event.toolResults;
    if (trs && Array.isArray(trs)) {
      for (const tr of trs) {
        const text = extractMessageText(tr);
        if (text.trim()) {
          const t = tok(text);
          pending.content.messages.push({ role: "toolResult", text, toolName: tr.toolName ?? tr.name, category: "results", tokens: t });
        }
      }
    }

    const e = pending.estimated;
    const tot = totalEst(e);

    const hasActual = inputTok >= 0 || outputTok >= 0 || cacheR > 0 || cacheW > 0 || turnCost > 0;
    const record: TurnRecord = {
      turnIndex: pending.turnIndex!,
      timestamp: pending.timestamp!,
      estimated: e,
      actual:    hasActual ? { 
                   in: inputTok >= 0 ? inputTok : null, 
                   out: outputTok >= 0 ? outputTok : null, 
                   cacheR: Math.max(0, cacheR), 
                   cacheW: Math.max(0, cacheW),
                   cost: turnCost,
                   savings: turnSavings
                 } : null,
      content:   pending.content,
    };
    turns.push(record);
    pending = null;

    // Update footer: use actual counts where available, fall back to estimates
    const ai  = record.actual?.in;
    const ao  = record.actual?.out;
    const cr  = record.actual?.cacheR ?? 0;
    const cw  = record.actual?.cacheW ?? 0;
    const ts  = record.actual?.savings ?? 0;
    
    // Calculate actual cumulative cost from the history of turns
    // instead of relying on sessionManager which drops messages on compaction
    let totalCost = 0;
    for (const h of turns) {
      if (h.actual?.cost) {
        totalCost += h.actual.cost;
      }
    }

    cum.base += e.base;
    cum.skills += e.skills;
    cum.tools += e.tools;
    cum.history += e.history;
    cum.results += e.results;
    cum.input += e.input;
    cum.cost = totalCost;
    cum.savings += ts;

    const t = ctx.ui.theme;
    const displayIn = ai != null ? ai : tot;
    
    // Add context window percentage to footer if available
    let ctxPctStr = "";
    const ctxUsage = ctx.getContextUsage();
    let ctxP = 0;
    if (ctxUsage?.percent != null) {
      ctxP = ctxUsage.percent;
      let ctxDisplay = `${ctxP.toFixed(1)}%`;
      const limit = (ctxUsage as any).contextWindow ?? (ctxUsage as any).limit;
      if (limit != null) {
        const limitStr = limit >= 1000000 
          ? `${(limit / 1000000).toFixed(1)}M` 
          : `${Math.round(limit / 1000)}k`;
        ctxDisplay += `/${limitStr}`;
      }
      const pColor = ctxP > 90 ? "error" : ctxP > 75 ? "accent" : "muted";
      ctxPctStr = t.fg(pColor, ctxDisplay);

      if (ctxUsage.tokens != null) {
        lastContextTokens = ctxUsage.tokens;
      }
    }

    // Thresholds for the receipt
    const isWarning = turnCost >= 0.10 || ctxP >= 75;
    const isCritical = turnCost >= 0.50 || ctxP >= 90;
    
    const baseColor = isCritical ? "error" : isWarning ? "accent" : "muted";
    const highlightColor = isCritical ? "error" : isWarning ? "accent" : "accent";
    
    const parts = [
      t.fg(baseColor, `✓ T${record.turnIndex + 1}:`),
      t.fg(highlightColor, `↑${fmt(displayIn)}`)
    ];
    
    if (ao != null) parts.push(t.fg(highlightColor, `↓${fmt(ao)}`));
    if (cr > 0) parts.push(t.fg("success", `R${fmt(cr)}`)); // Always green for savings
    if (cw > 0) parts.push(t.fg(isCritical ? "error" : "accent", `W${fmt(cw)}`));
    
    if (turnCost > 0) {
      const costStr = fmtCost(turnCost);
      if (isWarning || isCritical) {
        parts.push(t.fg(baseColor, costStr));
      } else {
        parts.push(t.fg("muted", costStr));
      }
    }
    
    if (ctxPctStr) parts.push(ctxPctStr);

    // Restore the default working indicator
    ctx.ui.setWorkingIndicator();
    
    // Restore the default working message
    ctx.ui.setWorkingMessage();
    
    // Print the persistent receipt into the history using exact pi spacing
    ctx.ui.notify(parts.join(" "), "info");
  });

  pi.on("session_before_compact", (_event, ctx) => {
    lastContextTokens = ctx.getContextUsage()?.tokens ?? lastContextTokens;
  });

  pi.on("session_compact", (_event, ctx) => {
    hasWarned80 = false;
    hasWarned90 = false;

    const newTokens = ctx.getContextUsage()?.tokens;
    if (lastContextTokens > 0 && newTokens != null) {
      ctx.ui.notify(
        `Context compacted: ${fmt(lastContextTokens)} → ${fmt(newTokens)} tokens`,
        "info"
      );
      lastContextTokens = newTokens;
    } else {
      ctx.ui.notify(
        "Context compacted — per-turn token counts will drop; cumulative totals reflect actual spend.",
        "info"
      );
    }
  });

  pi.on("session_start", (_event, ctx) => {
    turns.length = 0;
    cum = { base: 0, skills: 0, tools: 0, history: 0, results: 0, input: 0, totalIn: 0, totalOut: 0, cacheR: 0, cacheW: 0, cost: 0, savings: 0 };
    hasWarned80 = false;
    hasWarned90 = false;
    lastContextTokens = 0;
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingMessage();
    ctx.ui.notify(ctx.ui.theme.fg("muted", "token-stats ready · type /token-stats to inspect"), "info");
  });

  // ── /token-stats overlay ──────────────────────────────────────────────────────

  pi.registerCommand("token-stats", {
    description: "Per-turn token breakdown by category with drill-down (↑↓ select, Enter view, ←→ turns, Esc close)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (turns.length === 0) {
        ctx.ui.notify("No turns recorded yet — send a message first.", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => makeOverlay(turns, ctx, tui, theme, done),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 90, maxHeight: 48 },
        }
      );
    },
  });
}
