/**
 * Swift Poll - dashboard renderer + admin controller.
 *
 * Sections:
 *   - Manage Questions (admin): add + soft-delete
 *   - Aggregated results
 *   - User-wise responses (table on desktop, cards on mobile)
 *
 * After every admin mutation we:
 *   1. invalidate the Supabase cache
 *   2. re-render the admin list
 *   3. re-run aggregates + user responses
 * so the entire page stays consistent with the DB.
 */
(function () {
  const CFG = window.SWIFT_POLL_CONFIG || {};

  let el = {};
  let lastUserRows = [];        // retained for CSV export
  let activeQuestions = [];     // canonical ordered active list
  let pendingDeleteId = null;

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();

    el = {
      total:          document.querySelector("[data-total-submissions]"),
      aggregates:     document.querySelector("[data-aggregates]"),
      users:          document.querySelector("[data-user-responses]"),
      loading:        document.querySelector("[data-loading]"),
      empty:          document.querySelector("[data-empty-state]"),
      errorBox:       document.querySelector("[data-error]"),
      refreshBtn:     document.querySelector("[data-refresh]"),
      exportBtn:      document.querySelector("[data-export-csv]"),

      // Admin
      addForm:        document.querySelector("[data-add-question-form]"),
      addSubmit:      document.querySelector("[data-add-question-submit]"),
      addReset:       document.querySelector("[data-add-question-reset]"),
      addError:       document.querySelector("[data-add-question-error]"),
      qList:          document.querySelector("[data-questions-list]"),
      qCount:         document.querySelector("[data-questions-count]"),

      // Modal
      modal:          document.querySelector("[data-modal]"),
      modalConfirm:   document.querySelector("[data-modal-confirm]"),
      modalCancels:   document.querySelectorAll("[data-modal-cancel]"),
      modalBody:      document.querySelector("[data-modal-body]")
    };

    if (!gateDashboard()) return;

    el.refreshBtn && el.refreshBtn.addEventListener("click", loadAll);
    el.exportBtn  && el.exportBtn.addEventListener("click", exportCsv);

    wireAdminForm();
    wireModal();

    await loadAll();
  });

  // -------------------------------------------------------
  // Passcode gate
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
  // Main loader
  // -------------------------------------------------------
  async function loadAll() {
    showLoading(true);
    el.errorBox.textContent = "";
    el.empty.classList.add("is-hidden");

    try {
      SP.db.invalidateCache();

      const [questions, agg, users, total] = await Promise.all([
        SP.db.getActiveQuestions(),
        SP.db.getAggregatedResults(),
        SP.db.getUserResponses(),
        SP.db.getTotalSubmissions()
      ]);

      activeQuestions = questions;
      lastUserRows = users;
      el.total.textContent = String(total);

      renderAdminList(activeQuestions);

      if (!total || !users.length) {
        el.aggregates.innerHTML = "";
        el.users.innerHTML = "";
        el.empty.classList.remove("is-hidden");
      } else {
        renderAggregates(agg.questions);
        renderUsers(users, activeQuestions);
      }
    } catch (err) {
      console.error(err);
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard. Please try refreshing.");
    } finally {
      showLoading(false);
    }
  }

  function showLoading(on) { el.loading && el.loading.classList.toggle("is-hidden", !on); }

  // -------------------------------------------------------
  // Admin: add question
  // -------------------------------------------------------
  function wireAdminForm() {
    if (!el.addForm) return;

    // Live character counters
    el.addForm.querySelectorAll("[data-counter-for]").forEach((counter) => {
      const name = counter.getAttribute("data-counter-for");
      const input = el.addForm.querySelector(`[name='${name}']`);
      if (!input) return;
      const max = Number(input.getAttribute("maxlength")) || 0;
      const update = () => { counter.textContent = `${input.value.length} / ${max}`; };
      input.addEventListener("input", update);
      update();
    });

    el.addReset && el.addReset.addEventListener("click", () => {
      el.addForm.reset();
      el.addError.textContent = "";
      el.addForm.querySelectorAll("[data-counter-for]").forEach((c) => {
        const name = c.getAttribute("data-counter-for");
        const input = el.addForm.querySelector(`[name='${name}']`);
        const max = Number(input?.getAttribute("maxlength")) || 0;
        c.textContent = `0 / ${max}`;
      });
    });

    el.addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.addError.textContent = "";

      const fd = new FormData(el.addForm);
      const payload = {
        text: String(fd.get("questionText") || ""),
        options: [1, 2, 3, 4].map((i) => String(fd.get("option" + i) || ""))
      };

      el.addSubmit.disabled = true;
      const originalLabel = el.addSubmit.textContent;
      el.addSubmit.textContent = "Saving...";

      try {
        await SP.db.createQuestionWithOptions(payload);
        el.addForm.reset();
        el.addReset && el.addReset.click();
        SP.utils.toast("Question added.", "ok");
        await loadAll();
      } catch (err) {
        console.error(err);
        const errors = (err && err.validation) || [err?.message || "Could not save the question."];
        el.addError.innerHTML = errors.map((m) => `&bull; ${SP.utils.escapeHtml(m)}`).join("<br>");
      } finally {
        el.addSubmit.disabled = false;
        el.addSubmit.textContent = originalLabel || "Add Question";
      }
    });
  }

  // -------------------------------------------------------
  // Admin: render existing questions + wire delete
  // -------------------------------------------------------
  function renderAdminList(questions) {
    el.qCount.textContent = String(questions.length);
    if (!questions.length) {
      el.qList.innerHTML = `<p class="sp-muted sp-admin__list-empty">No questions yet. Add your first above.</p>`;
      return;
    }

    el.qList.innerHTML = questions.map((q, i) => {
      const opts = q.options.map((o) => `
        <li class="sp-q-row__opt">${SP.utils.escapeHtml(o.text)}</li>
      `).join("");
      return `
        <article class="sp-q-row" data-q-id="${SP.utils.escapeHtml(q.id)}">
          <header class="sp-q-row__head">
            <span class="sp-q-row__num">Q${i + 1}</span>
            <h4 class="sp-q-row__text">${SP.utils.escapeHtml(q.text)}</h4>
            <button type="button" class="sp-btn sp-btn--danger sp-btn--sm"
                    data-delete-question="${SP.utils.escapeHtml(q.id)}"
                    aria-label="Delete question ${i + 1}">
              Delete
            </button>
          </header>
          <ul class="sp-q-row__opts">${opts}</ul>
        </article>`;
    }).join("");

    el.qList.querySelectorAll("[data-delete-question]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-delete-question");
        const q = activeQuestions.find((x) => x.id === id);
        const snippet = q ? (q.text.length > 80 ? q.text.slice(0, 80) + "..." : q.text) : "";
        el.modalBody.innerHTML =
          `Deleting <strong>"${SP.utils.escapeHtml(snippet)}"</strong> will remove it from the live poll and dashboard. Continue?`;
        openModal(id);
      });
    });
  }

  // -------------------------------------------------------
  // Delete confirmation modal
  // -------------------------------------------------------
  function wireModal() {
    el.modalCancels.forEach((n) => n.addEventListener("click", closeModal));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.modal.classList.contains("is-hidden")) closeModal();
    });
    el.modalConfirm && el.modalConfirm.addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      el.modalConfirm.disabled = true;
      el.modalConfirm.textContent = "Deleting...";
      try {
        await SP.db.softDeleteQuestion(pendingDeleteId);
        SP.utils.toast("Question deleted.", "ok");
        closeModal();
        await loadAll();
      } catch (err) {
        console.error(err);
        SP.utils.toast(friendlyError(err, "Could not delete the question."), "error");
        el.modalConfirm.disabled = false;
        el.modalConfirm.textContent = "Delete";
      }
    });
  }

  function openModal(questionId) {
    pendingDeleteId = questionId;
    el.modal.classList.remove("is-hidden");
    el.modalConfirm.disabled = false;
    el.modalConfirm.textContent = "Delete";
  }
  function closeModal() {
    pendingDeleteId = null;
    el.modal.classList.add("is-hidden");
  }

  // -------------------------------------------------------
  // Aggregated results
  // -------------------------------------------------------
  function renderAggregates(questions) {
    if (!questions.length) { el.aggregates.innerHTML = ""; return; }

    const out = questions.map((q, qi) => {
      const total = q.total || 0;
      const optionsHtml = q.options
        .slice()
        .sort((a, b) => (a.order - b.order) || a.text.localeCompare(b.text))
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

      return `
        <article class="sp-agg-card">
          <header class="sp-agg-card__head">
            <span class="sp-agg-card__badge">Q${qi + 1}</span>
            <h3 class="sp-agg-card__title">${SP.utils.escapeHtml(q.text)}</h3>
          </header>
          <ul class="sp-bar-list">${optionsHtml}</ul>
          <footer class="sp-agg-card__foot">Total responses: <strong>${total}</strong></footer>
        </article>`;
    });

    el.aggregates.innerHTML = out.join("");
  }

  // -------------------------------------------------------
  // User-wise responses
  // -------------------------------------------------------
  function renderUsers(submissions, questions) {
    const activeIds = new Set(questions.map((q) => q.id));

    // Desktop table
    const tableHead = `
      <thead>
        <tr>
          <th>User</th>
          <th>Submitted</th>
          ${questions.map((q, i) => `<th title="${SP.utils.escapeHtml(q.text)}">Q${i + 1}</th>`).join("")}
        </tr>
      </thead>`;
    const rows = submissions.map((s) => {
      const byQ = {};
      (s.answers || []).forEach((a) => {
        if (a.question_id && activeIds.has(a.question_id)) {
          byQ[a.question_id] = a.selected_option_text;
        }
      });
      const name = s.user?.full_name || "Anonymous";
      const when = SP.utils.formatDate(s.submitted_at);
      const cells = questions.map((q) => `<td>${SP.utils.escapeHtml(byQ[q.id] || "-")}</td>`).join("");
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

    // Mobile cards
    const cardsHtml = submissions.map((s) => {
      const byQ = {};
      (s.answers || []).forEach((a) => {
        if (a.question_id && activeIds.has(a.question_id)) {
          byQ[a.question_id] = a.selected_option_text;
        }
      });
      const items = questions.map((q, i) => `
        <li><span class="sp-user-card__q">Q${i + 1}.</span>
          <span class="sp-user-card__a">${SP.utils.escapeHtml(byQ[q.id] || "-")}</span>
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

  // -------------------------------------------------------
  // CSV export
  // -------------------------------------------------------
  function exportCsv() {
    if (!lastUserRows.length) {
      SP.utils.toast("No data to export yet.", "error");
      return;
    }
    const questions = activeQuestions;
    const activeIds = new Set(questions.map((q) => q.id));

    const header = ["Name", "Submitted At", ...questions.map((_, i) => "Q" + (i + 1))];
    const lines = [header.map(csvEscape).join(",")];
    for (const s of lastUserRows) {
      const byQ = {};
      (s.answers || []).forEach((a) => {
        if (a.question_id && activeIds.has(a.question_id)) byQ[a.question_id] = a.selected_option_text;
      });
      const row = [
        s.user?.full_name || "Anonymous",
        SP.utils.formatDate(s.submitted_at),
        ...questions.map((q) => byQ[q.id] || "")
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
    if (/row-level security|RLS/i.test(msg)) return "Database blocked the write (RLS). Re-run supabase-schema.sql.";
    if (/Invalid API key|JWT|401/i.test(msg)) return "Invalid Supabase anon key.";
    if (/relation .* does not exist|schema cache/i.test(msg)) return "Database tables missing. Run supabase-schema.sql.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again in a moment.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
