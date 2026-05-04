/* ============================================================
   Lumen-bench browser
   Vanilla JS, no dependencies, no tracking.
   ============================================================ */

const PRESSURE_LABELS = {
  none: "no pressure",
  authority: "authority",
  urgency: "urgency",
  social: "social conformity",
  justification: "claimed legitimacy",
  incremental: "foot-in-the-door",
};

const LANG_FLAGS = { en: "EN", pt: "PT", es: "ES", zh: "ZH", hi: "HI" };

/* ============================================================
   LANDING PAGE
   ============================================================ */
async function renderLanding() {
  const agg = await fetchJSON("web-data/aggregates.json");

  animateCounters();
  renderHeatmap(agg);
  renderBarChart(agg);
}

function animateCounters() {
  const counters = document.querySelectorAll("[data-counter]");
  const animate = (el) => {
    const target = parseInt(el.dataset.counter, 10);
    const duration = 1100;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  // Intersection observer to trigger on scroll into view
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        animate(e.target);
        io.unobserve(e.target);
      }
    });
  });
  counters.forEach((c) => io.observe(c));
}

function renderHeatmap(agg) {
  const root = document.getElementById("heatmap");
  if (!root) return;

  const langs = ["en", "pt", "es", "zh", "hi"];
  const prompts = ["ethical", "neutral"];
  const rates = agg.rate_by_lang_prompt;
  const max = Math.max(...Object.values(rates));

  const colorFor = (rate) => {
    if (rate === 0) return "#fafafa";
    const t = rate / max;
    // interpolate cream → saydo purple
    const r = Math.round(250 - 105 * t);
    const g = Math.round(250 - 153 * t);
    const b = Math.round(250 - 56 * t);
    return `rgb(${r},${g},${b})`;
  };
  const textFor = (rate) => {
    return rate / max > 0.55 ? "#fff" : "var(--text)";
  };

  const html = [];
  // Top-left empty + lang headers
  html.push(`<div class="row-label"></div>`);
  for (const l of langs) html.push(`<div class="col-label">${LANG_FLAGS[l]}</div>`);
  // Rows
  for (const p of prompts) {
    html.push(`<div class="row-label">${p}</div>`);
    for (const l of langs) {
      const k = `${l}_${p}`;
      const v = rates[k] || 0;
      html.push(
        `<div class="cell" style="background:${colorFor(v)};color:${textFor(v)}" title="${l}/${p}: ${(v*100).toFixed(2)}% violations">${(v*100).toFixed(1)}%</div>`
      );
    }
  }
  root.innerHTML = html.join("");
}

function renderBarChart(agg) {
  const root = document.getElementById("barchart");
  if (!root) return;

  const items = Object.entries(agg.per_model)
    .map(([m, v]) => ({ model: m, rate: v.L3_behavioral_rate }))
    .sort((a, b) => a.rate - b.rate);

  const max = Math.max(...items.map((x) => x.rate));

  const html = items.map((it) => {
    const pct = (it.rate * 100).toFixed(2);
    const w = (it.rate / max) * 100;
    return `<div class="bar-row">
      <span class="label">${it.model}</span>
      <div class="bar-track"><div class="bar-fill" style="width:0%" data-target="${w}"></div></div>
      <span class="value">${pct}%</span>
    </div>`;
  }).join("");
  root.innerHTML = html;

  // Animate bars on mount
  requestAnimationFrame(() => {
    root.querySelectorAll(".bar-fill").forEach((el) => {
      el.style.width = `${el.dataset.target}%`;
    });
  });
}

/* ============================================================
   BROWSE PAGE
   ============================================================ */
const STATE = {
  index: [],            // array of {m,l,p,c,pr,q,j,v,l2}
  agg: null,
  judgeIndex: null,     // map "model|lang|prompt|question_id" → {j, r}
  filters: {
    lang: "all",
    prompt: "all",
    model: "all",
    category: "all",
    pressure: "all",
    judge: new Set(["COMPLY", "SAY_DO_GAP", "REDIRECT", "AMBIGUOUS"]),
    search: "",
  },
  page: 1,
  pageSize: 50,
  filtered: [],
  consolidatedCache: new Map(),
};

async function renderBrowse() {
  // Load aggregates first (small, instant)
  STATE.agg = await fetchJSON("web-data/aggregates.json");
  populateFilters(STATE.agg);

  // Wire up filter listeners now (will respond once index loads)
  wireFilters();

  // Load case index (larger, ~5MB gzipped) + judge index (~3MB) in parallel
  document.getElementById("count").innerHTML = '<span class="loading">Loading 207,360 cases</span>';
  const [idx, judgeIdx] = await Promise.all([
    fetchCaseIndex(),
    fetchJSON("web-data/judge_index.json"),
  ]);
  STATE.index = idx;
  STATE.judgeIndex = judgeIdx;

  applyFilters();
  wireModal();
}

async function fetchCaseIndex() {
  const res = await fetch("web-data/case_index.jsonl");
  const text = await res.text();
  const out = [];
  let idx = 0;
  for (const line of text.split("\n")) {
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

function populateFilters(agg) {
  const modelSel = document.getElementById("filter-model");
  agg.models.forEach((m) => {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    modelSel.appendChild(o);
  });

  const catSel = document.getElementById("filter-category");
  agg.categories.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c.replace(/_/g, " ");
    catSel.appendChild(o);
  });

  const presSel = document.getElementById("filter-pressure");
  agg.pressures.forEach((p) => {
    const o = document.createElement("option");
    o.value = p; o.textContent = PRESSURE_LABELS[p] || p;
    presSel.appendChild(o);
  });
}

function wireFilters() {
  const handle = () => { STATE.page = 1; applyFilters(); };

  // Pill groups (lang, prompt)
  ["filter-lang", "filter-prompt"].forEach((gid) => {
    const root = document.getElementById(gid);
    root.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill");
      if (!btn) return;
      root.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const key = gid === "filter-lang" ? "lang" : "prompt";
      STATE.filters[key] = btn.dataset.value;
      handle();
    });
  });

  // Selects
  document.getElementById("filter-model").addEventListener("change", (e) => {
    STATE.filters.model = e.target.value; handle();
  });
  document.getElementById("filter-category").addEventListener("change", (e) => {
    STATE.filters.category = e.target.value; handle();
  });
  document.getElementById("filter-pressure").addEventListener("change", (e) => {
    STATE.filters.pressure = e.target.value; handle();
  });

  // Judge checkboxes
  document.querySelectorAll('#filter-judge input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const set = STATE.filters.judge;
      if (cb.checked) set.add(cb.value); else set.delete(cb.value);
      handle();
    });
  });

  // Search (debounced)
  let searchT;
  document.getElementById("filter-search").addEventListener("input", (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      STATE.filters.search = e.target.value.toLowerCase().trim();
      handle();
    }, 200);
  });

  // Reset
  document.getElementById("reset-filters").addEventListener("click", () => {
    STATE.filters.lang = "all";
    STATE.filters.prompt = "all";
    STATE.filters.model = "all";
    STATE.filters.category = "all";
    STATE.filters.pressure = "all";
    STATE.filters.judge = new Set(["COMPLY", "SAY_DO_GAP", "REDIRECT", "AMBIGUOUS"]);
    STATE.filters.search = "";
    document.querySelectorAll(".pill-group .pill").forEach((p) => p.classList.toggle("active", p.dataset.value === "all"));
    document.getElementById("filter-model").value = "all";
    document.getElementById("filter-category").value = "all";
    document.getElementById("filter-pressure").value = "all";
    document.getElementById("filter-search").value = "";
    document.querySelectorAll('#filter-judge input[type="checkbox"]').forEach((cb) => {
      cb.checked = ["COMPLY","SAY_DO_GAP","REDIRECT","AMBIGUOUS"].includes(cb.value);
    });
    handle();
  });

  // Pagination
  document.getElementById("prev-page").addEventListener("click", () => {
    if (STATE.page > 1) { STATE.page--; renderCases(); }
  });
  document.getElementById("next-page").addEventListener("click", () => {
    const totalPages = Math.ceil(STATE.filtered.length / STATE.pageSize);
    if (STATE.page < totalPages) { STATE.page++; renderCases(); }
  });
}

function applyFilters() {
  const f = STATE.filters;
  const search = f.search;
  STATE.filtered = STATE.index.filter((r) => {
    if (f.lang !== "all" && r.l !== f.lang) return false;
    if (f.prompt !== "all" && r.p !== f.prompt) return false;
    if (f.model !== "all" && r.m !== f.model) return false;
    if (f.category !== "all" && r.c !== f.category) return false;
    if (f.pressure !== "all" && r.pr !== f.pressure) return false;
    if (!f.judge.has(r.j)) return false;
    if (search && !r.q.toLowerCase().includes(search) && !r.c.toLowerCase().includes(search)) return false;
    return true;
  });

  document.getElementById("count").innerHTML = `<strong>${STATE.filtered.length.toLocaleString()}</strong> of ${STATE.index.length.toLocaleString()} cases`;
  renderCases();
}

function renderCases() {
  const list = document.getElementById("case-list");
  const totalPages = Math.ceil(STATE.filtered.length / STATE.pageSize) || 1;
  if (STATE.page > totalPages) STATE.page = totalPages;

  const start = (STATE.page - 1) * STATE.pageSize;
  const end = start + STATE.pageSize;
  const slice = STATE.filtered.slice(start, end);

  if (slice.length === 0) {
    list.innerHTML = '<li class="empty-state">No cases match these filters.</li>';
    document.getElementById("pagination").hidden = true;
    return;
  }

  list.innerHTML = slice.map((r, i) => {
    const idx = start + i;
    return `<li class="case-card" data-idx="${idx}">
      <div>
        <div class="meta">
          <span class="badge model">${r.m}</span>
          <span class="badge lang">${LANG_FLAGS[r.l]}</span>
          <span class="badge cat">${r.c.replace(/_/g, " ")}</span>
          ${r.pr !== "none" ? `<span class="badge pres">${PRESSURE_LABELS[r.pr] || r.pr}</span>` : ""}
          <span class="badge judge ${r.j}">${r.j}</span>
        </div>
        <div class="question-preview">${escapeHtml(formatQuestionId(r.q))}</div>
      </div>
      <div></div>
    </li>`;
  }).join("");

  // Pagination
  const pag = document.getElementById("pagination");
  pag.hidden = STATE.filtered.length <= STATE.pageSize;
  document.getElementById("page-info").textContent = `Page ${STATE.page} of ${totalPages}`;
  document.getElementById("prev-page").disabled = STATE.page <= 1;
  document.getElementById("next-page").disabled = STATE.page >= totalPages;

  // Click → modal
  list.querySelectorAll(".case-card").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      openCase(STATE.filtered[idx]);
    });
  });
}

function formatQuestionId(qid) {
  // The question_id encodes scenario + lang + pressure + numeric suffix.
  // For preview, just turn underscores into spaces and capitalize the first letter.
  return qid.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/* ============================================================
   MODAL (case detail)
   ============================================================ */
function wireModal() {
  document.getElementById("modal-close").addEventListener("click", closeCase);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeCase();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCase();
  });

  document.querySelectorAll(".modal-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modal-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

async function openCase(rec) {
  const modal = document.getElementById("modal");
  modal.hidden = false;
  document.body.style.overflow = "hidden";

  // Reset to first tab
  document.querySelectorAll(".modal-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === "response"));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === "tab-response"));

  // Show loading
  document.getElementById("modal-question").textContent = "Loading…";
  document.getElementById("modal-meta").innerHTML = "";
  document.getElementById("tab-response").innerHTML = '<div class="loading">Loading case</div>';
  document.getElementById("tab-tools").innerHTML = "";
  document.getElementById("tab-judge").innerHTML = "";
  document.getElementById("tab-raw").innerHTML = "";

  try {
    const consolidated = await loadConsolidated(rec.l, rec.p, rec.m);
    const entry = consolidated.find((e) => e.question_id === rec.q);
    if (!entry) throw new Error("Case not found in consolidated.json");
    renderCaseDetail(rec, entry);
  } catch (err) {
    document.getElementById("tab-response").innerHTML =
      `<div class="empty-state">Could not load this case: ${escapeHtml(err.message)}</div>`;
  }
}

function closeCase() {
  document.getElementById("modal").hidden = true;
  document.body.style.overflow = "";
}

async function loadConsolidated(lang, prompt, model) {
  const key = `${lang}/${prompt}/${model}`;
  if (STATE.consolidatedCache.has(key)) return STATE.consolidatedCache.get(key);
  const url = `eval_results_consolidated/${lang}/${prompt}/${model}/consolidated.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  STATE.consolidatedCache.set(key, data);
  return data;
}

function renderCaseDetail(rec, entry) {
  // Header
  const meta = document.getElementById("modal-meta");
  meta.innerHTML = `
    <span class="badge model">${rec.m}</span>
    <span class="badge lang">${LANG_FLAGS[rec.l]}</span>
    <span class="badge cat">${rec.c.replace(/_/g, " ")}</span>
    ${rec.pr !== "none" ? `<span class="badge pres">${PRESSURE_LABELS[rec.pr]}</span>` : ""}
    <span class="badge judge ${rec.j}">${rec.j}</span>
    <span class="badge" style="background:var(--bg-alt);color:var(--text-soft)">${rec.p}</span>
  `;

  document.getElementById("modal-question").textContent = entry.question_text || entry.question || "(question text unavailable)";

  // Response tab
  const respPane = document.getElementById("tab-response");
  if (entry.assistant_response) {
    respPane.innerHTML = `<div class="assistant-response">${renderMarkdown(entry.assistant_response)}</div>`;
  } else if (entry.error) {
    respPane.innerHTML = `<div class="empty-state">Model returned an error:<br><code>${escapeHtml(entry.error)}</code></div>`;
  } else {
    respPane.innerHTML = `<div class="empty-state">No assistant text response (model called only tools).</div>`;
  }

  // Tool calls tab — full tool calls live in conversation, not tools_called (which is just names)
  const toolsPane = document.getElementById("tab-tools");
  const assistantMsg = (entry.conversation || []).find((m) => m.role === "assistant");
  const toolCalls = assistantMsg?.tool_calls || [];
  if (toolCalls.length === 0) {
    toolsPane.innerHTML = `<div class="empty-state">No tool calls. The model responded with text only.</div>`;
  } else {
    toolsPane.innerHTML = toolCalls.map((tc) => {
      const name = tc.function?.name || tc.name || "(unknown tool)";
      let args = tc.function?.arguments || tc.arguments || tc.args || "{}";
      if (typeof args === "string") {
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (e) {}
      } else {
        args = JSON.stringify(args, null, 2);
      }
      return `<div class="tool-call">
        <div class="tool-name">${escapeHtml(name)}(...)</div>
        <pre class="code">${escapeHtml(args)}</pre>
      </div>`;
    }).join("");
  }

  // Judge tab — pull verbatim reason from judge_index when available
  const judgePane = document.getElementById("tab-judge");
  const judgeKey = `${rec.m}|${rec.l}|${rec.p}|${rec.q}`;
  const judgeData = STATE.judgeIndex?.[judgeKey];
  const reasonHtml = judgeData?.r
    ? `<div class="reason">${escapeHtml(judgeData.r)}</div>`
    : "";
  const judgeContext = rec.l2
    ? `<span style="color: var(--text-soft); font-size: 0.875rem;">o4-mini-2025-04-16 (reasoning_effort=medium)</span>`
    : `<span style="color: var(--text-soft); font-size: 0.875rem;">No judge ran on this case (no substantive tool call)</span>`;
  judgePane.innerHTML = `
    <div class="judge-card">
      <div class="label-row">
        <span class="badge judge ${rec.j}" style="font-size:0.875rem; padding: 4px 12px;">${rec.j}</span>
        ${judgeContext}
      </div>
      ${reasonHtml}
    </div>
    <div style="margin-top: 1rem; font-size: 0.875rem; color: var(--text-soft);">
      <p><strong>L0</strong> (any tool call): ${toolCalls.length > 0 ? "yes" : "no"}</p>
      <p><strong>L2</strong> (substantive parameters): ${rec.l2 ? "yes" : "no"}</p>
      <p><strong>L3-behavioral</strong> (COMPLY or SAY_DO_GAP): ${rec.v ? "yes — harm executed" : "no"}</p>
    </div>
  `;

  // Raw tab
  document.getElementById("tab-raw").innerHTML = `<pre class="code">${escapeHtml(JSON.stringify(entry, null, 2))}</pre>`;
}

/* ============================================================
   Helpers
   ============================================================ */
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tiny markdown-ish renderer for assistant_response
function renderMarkdown(text) {
  let s = escapeHtml(text);
  // Code fences
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => `<pre class="code">${code}</pre>`);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold and italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // Headers (line-anchored)
  s = s.replace(/^###\s+(.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^##\s+(.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^#\s+(.+)$/gm, "<h2>$1</h2>");
  // Bulleted lists (consecutive lines starting with -, *, or numeric.)
  s = s.replace(/(^|\n)((?:[-*]|\d+\.)\s+.+(?:\n(?:[-*]|\d+\.)\s+.+)*)/g, (_, lead, block) => {
    const items = block.split("\n").map((line) => {
      const m = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      return m ? `<li>${m[1]}</li>` : line;
    }).join("");
    return `${lead}<ul>${items}</ul>`;
  });
  return s;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}
