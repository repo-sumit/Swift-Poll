/**
 * Swift Poll - dashboard renderer.
 *
 * Two sections:
 *   A. Aggregated results (per question: option counts + %)
 *   B. User-wise responses (one row per submission)
 *
 * A single pair of Supabase calls feeds both sections, so a
 * refresh stays cheap even as submissions grow.
 */
(function () {
  const CFG = window.SWIFT_POLL_CONFIG || {};

  let el = {};
  let lastUserRows = [];     // retained for CSV export

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();

    el = {
      total:        document.querySelector("[data-total-submissions]"),
      aggregates:   document.querySelector("[data-aggregates]"),
      users:        document.querySelector("[data-user-responses]"),
      loading:      document.querySelector("[data-loading]"),
      empty:        document.querySelector("[data-empty-state]"),
      errorBox:     document.querySelector("[data-error]"),
      refreshBtn:   document.querySelector("[data-refresh]"),
      exportBtn:    document.querySelector("[data-export-csv]"),
      goHome:       document.querySelector("[data-go-home]"),
      goPoll:       document.querySelector("[data-go-poll]")
    };

    if (!gateDashboard()) return;

    el.refreshBtn && el.refreshBtn.addEventListener("click", loadAll);
    el.exportBtn  && el.exportBtn.addEventListener("click", exportCsv);

    await loadAll();
  });

  // -------------------------------------------------------
  // Optional passcode gate
  // -------------------------------------------------------
  function gateDashboard() {
    const pass = (CFG.DASHBOARD_PASSCODE || "").trim();
    if (!pass) return true;
    const stored = localStorage.getItem(SP.utils.STORAGE_KEYS.DASH_AUTH);
    if (stored === pass) return true;
    const entered = window.prompt("Enter dashboard passcode:");
    if (entered && entered === pass) {
      localStorage.setItem(SP.utils.STORAGE_KEYS.DASH_AUTH, entered);
      return true;
    }
    document.body.innerHTML = '<div class="sp-gate">Access denied.</div>';
    return false;
  }

  // -------------------------------------------------------
  // Data load
  // -------------------------------------------------------
  async function loadAll() {
    showLoading(true);
    el.errorBox.textContent = "";
    el.empty.classList.add("is-hidden");

    try {
      const [agg, users, total] = await Promise.all([
        SP.db.getAggregatedResults(),
        SP.db.getUserResponses(),
        SP.db.getTotalSubmissions()
      ]);

      lastUserRows = users;
      el.total.textContent = String(total);

      if (!total || !users.length) {
        el.aggregates.innerHTML = "";
        el.users.innerHTML = "";
        el.empty.classList.remove("is-hidden");
      } else {
        renderAggregates(agg.questions);
        renderUsers(users);
      }
    } catch (err) {
      console.error(err);
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard. Please try refreshing.");
    } finally {
      showLoading(false);
    }
  }

  function showLoading(on) {
    if (!el.loading) return;
    el.loading.classList.toggle("is-hidden", !on);
  }

  // -------------------------------------------------------
  // Aggregated results
  // -------------------------------------------------------
  function renderAggregates(questions) {
    const out = [];
    questions.forEach((q, qi) => {
      const total = q.total || 0;
      const optionsHtml = [...q.options]
        .sort((a, b) => a.text.localeCompare(b.text))
        .map((o) => {
          const pct = total > 0 ? Math.round((o.count / total) * 100) : 0;
          return `
            <li class="sp-bar">
              <div class="sp-bar__head">
                <span class="sp-bar__label">${SP.utils.escapeHtml(o.text)}</span>
                <span class="sp-bar__val">${o.count} <span class="sp-bar__pct">(${pct}%)</span></span>
              </div>
              <div class="sp-bar__track" aria-hidden="true">
                <div class="sp-bar__fill sp-bar__fill--${SP.utils.escapeHtml(o.value)}" style="width:${pct}%"></div>
              </div>
            </li>`;
        })
        .join("");

      out.push(`
        <article class="sp-agg-card">
          <header class="sp-agg-card__head">
            <span class="sp-agg-card__badge">Q${qi + 1}</span>
            <h3 class="sp-agg-card__title">${SP.utils.escapeHtml(q.text)}</h3>
          </header>
          <ul class="sp-bar-list">${optionsHtml}</ul>
          <footer class="sp-agg-card__foot">Total responses: <strong>${total}</strong></footer>
        </article>
      `);
    });
    el.aggregates.innerHTML = out.join("");
  }

  // -------------------------------------------------------
  // User-wise responses (responsive: table on wide, cards on mobile)
  // -------------------------------------------------------
  function renderUsers(submissions) {
    // Collect questions in order from the first submission that has them
    const orderedQuestions = deriveQuestionOrder(submissions);

    // --- Desktop table
    const tableHead = `
      <thead>
        <tr>
          <th>User</th>
          <th>Submitted</th>
          ${orderedQuestions.map((q, i) => `<th title="${SP.utils.escapeHtml(q)}">Q${i + 1}</th>`).join("")}
        </tr>
      </thead>`;
    const rows = submissions.map((s) => {
      const answerByQ = {};
      (s.answers || []).forEach((a) => { answerByQ[a.question?.question_text] = a.selected_option_text; });
      const name    = s.user?.full_name || "Anonymous";
      const when    = SP.utils.formatDate(s.submitted_at);
      const cells   = orderedQuestions.map((q) => `<td>${SP.utils.escapeHtml(answerByQ[q] || "-")}</td>`).join("");
      return `<tr>
        <td>${SP.utils.escapeHtml(name)}</td>
        <td class="sp-muted">${SP.utils.escapeHtml(when)}</td>
        ${cells}
      </tr>`;
    }).join("");

    const tableHtml = `
      <div class="sp-table-wrap">
        <table class="sp-table">${tableHead}<tbody>${rows}</tbody></table>
      </div>`;

    // --- Mobile card list
    const cardsHtml = submissions.map((s) => {
      const answerByQ = {};
      (s.answers || []).forEach((a) => { answerByQ[a.question?.question_text] = a.selected_option_text; });
      const items = orderedQuestions.map((q, i) => `
        <li><span class="sp-user-card__q">Q${i + 1}.</span>
          <span class="sp-user-card__a">${SP.utils.escapeHtml(answerByQ[q] || "-")}</span>
        </li>`).join("");
      const name = s.user?.full_name || "Anonymous";
      return `
        <article class="sp-user-card">
          <header class="sp-user-card__head">
            <div>
              <h4 class="sp-user-card__name">${SP.utils.escapeHtml(name)}</h4>
            </div>
            <time class="sp-user-card__time">${SP.utils.escapeHtml(SP.utils.formatDate(s.submitted_at))}</time>
          </header>
          <ul class="sp-user-card__answers">${items}</ul>
        </article>`;
    }).join("");

    el.users.innerHTML = `
      <div class="sp-users__desktop">${tableHtml}</div>
      <div class="sp-users__mobile">${cardsHtml}</div>`;
  }

  function deriveQuestionOrder(submissions) {
    // Use config order if available; fall back to whatever order the DB returns
    const fromCfg = (CFG.QUESTIONS || []).slice().sort((a, b) => a.order - b.order).map((q) => q.text);
    if (fromCfg.length) return fromCfg;

    const seen = new Map();
    for (const s of submissions) {
      for (const a of s.answers || []) {
        const text = a.question?.question_text;
        const order = a.question?.display_order ?? 9999;
        if (text && !seen.has(text)) seen.set(text, order);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
  }

  // -------------------------------------------------------
  // CSV export - purely client-side
  // -------------------------------------------------------
  function exportCsv() {
    if (!lastUserRows.length) {
      SP.utils.toast("No data to export yet.", "error");
      return;
    }
    const questions = deriveQuestionOrder(lastUserRows);
    const header = ["Name", "Submitted At", ...questions.map((_, i) => "Q" + (i + 1))];
    const lines = [header.map(csvEscape).join(",")];
    for (const s of lastUserRows) {
      const byQ = {};
      (s.answers || []).forEach((a) => { byQ[a.question?.question_text] = a.selected_option_text; });
      const row = [
        s.user?.full_name || "Anonymous",
        SP.utils.formatDate(s.submitted_at),
        ...questions.map((q) => byQ[q] || "")
      ];
      lines.push(row.map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swift-poll-responses-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/Supabase URL not configured|Supabase client library not loaded/i.test(msg))
      return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/Invalid API key|JWT|401/i.test(msg)) return "Invalid Supabase anon key.";
    if (/relation .* does not exist|schema cache/i.test(msg)) return "Database tables missing. Run supabase-schema.sql.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again in a moment.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
