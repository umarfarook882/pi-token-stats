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
import { encode } from "gpt-tokenizer/model/gpt-4o";

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
}

interface TurnRecord {
  turnIndex: number;
  timestamp: number;
  estimated: CategoryStats;
  actual: { in: number | null; out: number | null; cacheR: number; cacheW: number } | null;
  content: {
    systemPrompt: string;
    toolsJson: string;
    messages: MsgSnapshot[];
  };
}

// ─── Token helpers ──────────────────────────────────────────────────────────────

function tok(text: string): number {
  try { return encode(text).length; }
  catch { return Math.ceil(text.length / 4); }
}

function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .map((b) =>
        b?.type === "text"        ? (b.text ?? "") :
        b?.type === "toolCall"    ? `${b.name} ${JSON.stringify(b.arguments ?? {})}` :
        b?.type === "thinking"    ? (b.thinking ?? "") :
        b?.type === "image"       ? " 0".repeat(400) :
        b?.type === "tool_result" ? extractText(b.content) :
        b?.text ?? b?.content ?? ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function parseSystemPrompt(prompt: string) {
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

function totalEst(e: CategoryStats): number {
  return e.base + e.skills + e.metadata + e.tools + e.history + e.results + e.input;
}

// Sorted by descending token count for the table; bar order is fixed
const CATS: Array<{ key: keyof CategoryStats; label: string; color: string }> = [
  { key: "tools",    label: "Tool definitions",  color: "error"   },
  { key: "history",  label: "History",           color: "success" },
  { key: "results",  label: "Tool results",      color: "warning" },
  { key: "metadata", label: "Metadata",          color: "accent"  },
  { key: "skills",   label: "Skills",            color: "mdLink"  },
  { key: "base",     label: "System (base)",     color: "muted"   },
  { key: "input",    label: "User message",      color: "dim"     },
];

// ─── Overlay component ──────────────────────────────────────────────────────────

function makeOverlay(
  history: TurnRecord[],
  pi: ExtensionAPI,
  tui: any,
  theme: any,
  done: (v: void) => void,
) {
  let turnIdx  = history.length - 1;
  let inDrill  = false;
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
      case "skills":   raw = parsed.skillsText || "(no <available_skills> block found)"; break;
      case "metadata": raw = parsed.metaText || "(no metadata found)"; break;
      case "tools":    raw = rec.content.toolsJson || "(no tools)"; break;
      case "history":
        raw = rec.content.messages
          .filter(m => m.category === "history")
          .map(m => `── [${m.role}] ──────────────────────────────\n${m.text}`)
          .join("\n\n") || "(no conversation history)";
        break;
      case "results":
        raw = rec.content.messages
          .filter(m => m.category === "results")
          .map(m => `── [tool: ${m.toolName ?? "unknown"}] ──────────────────────────────\n${m.text}`)
          .join("\n\n") || "(no tool results in context)";
        break;
      case "input":
        raw = rec.content.messages.find(m => m.category === "input")?.text ?? "(no user message captured)";
        break;
    }

    return raw.split("\n");
  }

  const DRILL_VISIBLE = 30;

  return {
    render(width: number): string[] {
      const rec  = history[turnIdx];
      const e    = rec.estimated;
      const tot  = totalEst(e);
      const out: string[] = [];

      if (!inDrill) {
        // ── Header ────────────────────────────────────────────
        const title   = theme.bold(" Token Stats ");
        const turnNav = theme.fg("muted", `Turn ${turnIdx + 1}/${history.length}  ← → to switch`);
        out.push(`${title} ${turnNav}`);
        out.push("");

        // ── Actual vs estimated ────────────────────────────────
        if (rec.actual) {
          const ai = rec.actual.in;
          const ao = rec.actual.out;
          const { cacheR, cacheW } = rec.actual;
          const inStr = ai != null ? fmt(ai + cacheR + cacheW) : `~${fmt(tot)}`;
          const outStr = ao != null ? fmt(ao) : "??";
          out.push(`  ${theme.fg("mdLink", "Actual")}    ↑ ${inStr}  ↓ ${outStr}  cache_r ${fmt(cacheR)}  cache_w ${fmt(cacheW)}`);
        } else {
          out.push(`  ${theme.fg("muted", "Actual")}    (not captured — provider may not expose per-call usage)`);
        }
        out.push(`  ${theme.fg("muted", "Estimated")} ↑ ~${fmt(tot)} total (o200k_base)`);
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
          e[c.key] > 0 ? theme.fg(c.color, `■ ${c.label.split(" ")[0]}`) : ""
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
        out.push(theme.fg("muted", "  ↑↓: select category   Enter: view content   ← →: switch turn   Esc: close"));
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
          `  Lines ${scrollY + 1}–${Math.min(scrollY + DRILL_VISIBLE, drillLines.length)} / ${drillLines.length}`
        ));
      }

      return out;
    },

    invalidate() {},

    handleInput(data: string) {
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
        } else if (data === "\r" || data === "\n") {
          drillLines = buildDrillLines(history[turnIdx]);
          inDrill    = true;
          scrollY    = 0;
        } else if (matchesKey(data, "escape")) {
          done(undefined);
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
        } else if (matchesKey(data, "escape")) {
          inDrill = false;
          scrollY = 0;
        }
      }
      tui.requestRender();
    },
  };
}

// ─── Extension entry ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const turns: TurnRecord[]      = [];
  let pending: Partial<TurnRecord> | null = null;
  let inputTok = -1, outputTok = -1, cacheR = -1, cacheW = -1;
  let cum = { base: 0, skills: 0, tools: 0, history: 0, results: 0, input: 0, totalIn: 0, totalOut: 0, cacheR: 0, cacheW: 0 };

  // ── Turn lifecycle ────────────────────────────────────────────────────────────

  pi.on("turn_start", (event, _ctx) => {
    pending = { turnIndex: event.turnIndex, timestamp: Date.now(), actual: null };
    inputTok = outputTok = cacheR = cacheW = -1;
  });

  pi.on("context", (event, ctx) => {
    if (!pending) return;

    const systemPrompt = ctx.getSystemPrompt();
    const parsed       = parseSystemPrompt(systemPrompt);

    // Tool tokens — schemas sent separately via the tools API param
    const activeTools = pi.getActiveTools();
    const toolsJson   = activeTools.map(t => JSON.stringify(t, null, 2)).join("\n\n---\n\n");
    const toolsTok    = tok(toolsJson);

    // Categorize messages in context
    const msgs: any[]           = (event as any).messages ?? [];
    const snapshots: MsgSnapshot[] = [];
    let histTok = 0, resTok = 0, inTok = 0;

    for (let i = 0; i < msgs.length; i++) {
      const msg  = msgs[i];
      if (msg.excludeFromContext) continue;
      
      const text = extractMessageText(msg);
      const t    = tok(text);

      if (msg.role === "toolResult") {
        resTok += t;
        snapshots.push({ role: "toolResult", text, toolName: msg.toolName ?? msg.name, category: "results" });
      } else if (i === msgs.length - 1) {
        inTok = t;
        snapshots.push({ role: msg.role, text, category: "input" });
      } else {
        histTok += t;
        snapshots.push({ role: msg.role, text, category: "history" });
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
    const cumCacheStr = (cum.cacheR > 0 || cum.cacheW > 0)
      ? t.fg("muted", " | ") + t.fg("accent", `∑cr:${fmt(cum.cacheR)} ∑cw:${fmt(cum.cacheW)}`)
      : "";

    ctx.ui.setStatus("token-stats", undefined);
    ctx.ui.setWidget(
      "token-stats",
      [
        t.fg("muted", "Turn ") + t.fg("accent", `~↑${fmt(tot)} `) + t.fg("muted", `sys:${fmt(e.base)} sk:${fmt(e.skills)} tl:${fmt(e.tools)} hi:${fmt(e.history)} tr:${fmt(e.results)} in:${fmt(e.input)}`),
        t.fg("muted", "Cum. ") + t.fg("accent", `~∑↑${fmt(cum.totalIn + tot)} `) + t.fg("muted", `sys:${fmt(cum.base + e.base)} sk:${fmt(cum.skills + e.skills)} tl:${fmt(cum.tools + e.tools)} hi:${fmt(cum.history + e.history)} tr:${fmt(cum.results + e.results)} in:${fmt(cum.input + e.input)} | `) + t.fg("accent", `∑↓${cum.totalOut > 0 ? fmt(cum.totalOut) : ""}…`) + cumCacheStr
      ],
      { placement: "belowEditor" }
    );
  });

  // Capture actual usage from provider stream events
  pi.on("message_update", (event, _ctx) => {
    const se = (event as any).assistantMessageEvent;
    if (!se) return;
    
    const usage = se.type === "done" ? se.message?.usage : se.partial?.usage;
    if (usage) {
      if (usage.input !== undefined) inputTok = Math.max(inputTok, usage.input);
      if (usage.output !== undefined) outputTok = Math.max(outputTok, usage.output);
      if (usage.cacheRead !== undefined) cacheR = Math.max(cacheR, usage.cacheRead);
      if (usage.cacheWrite !== undefined) cacheW = Math.max(cacheW, usage.cacheWrite);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!pending?.estimated) { pending = null; return; }

    const hasActual = inputTok >= 0 || outputTok >= 0 || cacheR > 0 || cacheW > 0;
    const record: TurnRecord = {
      turnIndex: pending.turnIndex!,
      timestamp: pending.timestamp!,
      estimated: pending.estimated,
      actual:    hasActual ? { 
                   in: inputTok >= 0 ? inputTok : null, 
                   out: outputTok >= 0 ? outputTok : null, 
                   cacheR: Math.max(0, cacheR), 
                   cacheW: Math.max(0, cacheW) 
                 } : null,
      content:   pending.content ?? { systemPrompt: "", toolsJson: "", messages: [] },
    };
    turns.push(record);
    pending = null;

    // Update footer: use actual counts where available, fall back to estimates
    const e   = record.estimated;
    const tot = totalEst(e);
    const ai  = record.actual?.in;
    const ao  = record.actual?.out;
    const cr  = record.actual?.cacheR ?? 0;
    const cw  = record.actual?.cacheW ?? 0;
    
    const actualInTotal = ai != null ? (ai + cr + cw) : tot;

    cum.base += e.base;
    cum.skills += e.skills;
    cum.tools += e.tools;
    cum.history += e.history;
    cum.results += e.results;
    cum.input += e.input;
    cum.totalIn += actualInTotal;
    if (ao != null) cum.totalOut += ao;
    cum.cacheR += cr;
    cum.cacheW += cw;
    const cumCR = cum.cacheR;
    const cumCW = cum.cacheW;

    const t = ctx.ui.theme;
    const est = ai == null ? "~" : "";
    const displayIn = ai != null ? actualInTotal : tot;
    
    const turnCacheStr = (cr > 0 || cw > 0) ? t.fg("muted", " | ") + t.fg("accent", `cr:${fmt(cr)} cw:${fmt(cw)}`) : "";
    const cumCacheStr  = (cumCR > 0 || cumCW > 0) ? t.fg("muted", " | ") + t.fg("accent", `∑cr:${fmt(cumCR)} ∑cw:${fmt(cumCW)}`) : "";

    ctx.ui.setStatus("token-stats", undefined);
    ctx.ui.setWidget(
      "token-stats",
      [
        t.fg("muted", "Turn ") + t.fg("accent", `${est}↑${fmt(displayIn)} `) + t.fg("muted", `sys:${fmt(e.base)} sk:${fmt(e.skills)} tl:${fmt(e.tools)} hi:${fmt(e.history)} tr:${fmt(e.results)} in:${fmt(e.input)}`) + (ao != null ? t.fg("muted", " | ") + t.fg("accent", `↓${fmt(ao)}`) : "") + turnCacheStr,
        t.fg("muted", "Cum. ") + t.fg("accent", `${est}∑↑${fmt(cum.totalIn)} `) + t.fg("muted", `sys:${fmt(cum.base)} sk:${fmt(cum.skills)} tl:${fmt(cum.tools)} hi:${fmt(cum.history)} tr:${fmt(cum.results)} in:${fmt(cum.input)} | `) + t.fg("accent", `∑↓${fmt(cum.totalOut)}`) + cumCacheStr
      ],
      { placement: "belowEditor" }
    );
  });

  pi.on("session_compact", (_event, ctx) => {
    ctx.ui.notify(
      "Context compacted — per-turn token counts will drop; cumulative totals reflect actual spend.",
      "info"
    );
  });

  pi.on("session_start", (_event, ctx) => {
    turns.length = 0;
    cum = { base: 0, skills: 0, tools: 0, history: 0, results: 0, input: 0, totalIn: 0, totalOut: 0, cacheR: 0, cacheW: 0 };
    ctx.ui.setStatus("token-stats", undefined);
    ctx.ui.setWidget(
      "token-stats",
      [ctx.ui.theme.fg("muted", "token-stats ready  /token-stats to inspect")],
      { placement: "belowEditor" }
    );
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
        (tui, theme, _kb, done) => makeOverlay(turns, pi, tui, theme, done),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 90, maxHeight: 48 },
        }
      );
    },
  });
}
