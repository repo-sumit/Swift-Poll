/**
 * Swift Poll - dashboard controller (v4: roles + user mgmt + reset)
 *
 * Admin:
 *   - Manage Questions (MCQ/text, required flag)
 *   - Manage Users (add/rename/change-password/soft-delete)
 *   - Delete any submission
 *   - Export CSV, Reset poll data (export-then-wipe)
 * Normal user:
 *   - Scope locked to their own user filter
 *   - No management, no deletes, no reset
 *
 * Session shape: { id, displayName, role } in sessionStorage
 * under `swift_poll.dashboard_session`.
 */
(function () {
  const SESSION_KEY = "swift_poll.dashboard_session";
  const LIMITS = (SP.db && SP.db.LIMITS) || { OPTION_MIN: 2, OPTION_MAX: 5 };

  let el = {};
  let session = null;           // { id, displayName, role }
  let dashboardUsers = [];      // full list (admin + user)
  let lastUserRows = [];
  let activeQuestions = [];
  let pendingDeleteQId = null;
  let pendingDeleteSubId = null;
  let pendingPasswordUserId = null;
  let currentFilter = "all";    // "all" or dashboard_users.id

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();
    cacheEls();

    session = readSession();
    if (!session || !session.id) {
      window.location.replace("dashboard-access.html");
      return;
    }

    showWho();
    applyRoleVisibility();
    wireCommonButtons();
    wireAdminForms();
    wireModals();

    try {
      dashboardUsers = await SP.db.listDashboardUsers();
    } catch (err) {
      console.error(err);
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard accounts.");
      return;
    }

    initFilter();
    await loadAll();
  });

  // -------------------------------------------------------
  // Session / role
  // -------------------------------------------------------
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_) { return null; }
  }
  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }
  function isAdmin() { return session && session.role === "admin"; }

  function showWho() {
    if (!el.who) return;
    const badge = isAdmin() ? "Admin" : "User";
    el.who.textContent = `${session.displayName} (${badge})`;
  }

  function applyRoleVisibility() {
    const adminOnly = document.querySelectorAll("[data-admin-only]");
    adminOnly.forEach((n) => n.classList.toggle("is-hidden", !isAdmin()));
  }

  // -------------------------------------------------------
  // DOM cache
  // -------------------------------------------------------
  function cacheEls() {
    el = {
      who:            document.querySelector("[data-session-who]"),
      total:          document.querySelector("[data-total-submissions]"),
      aggregates:     document.querySelector("[data-aggregates]"),
      users:          document.querySelector("[data-user-responses]"),
      loading:        document.querySelector("[data-loading]"),
      empty:          document.querySelector("[data-empty-state]"),
      errorBox:       document.querySelector("[data-error]"),
      dashSub:        document.querySelector("[data-dash-sub]"),

      refreshBtn:     document.querySelector("[data-refresh]"),
      exportBtn:      document.querySelector("[data-export-csv]"),
      resetBtn:       document.querySelector("[data-open-reset]"),
      logoutBtn:      document.querySelector("[data-logout]"),

      filterSelect:   document.querySelector("[data-filter-user]"),
      filterHint:     document.querySelector("[data-filter-hint]"),

      // Admin: questions
      addForm:        document.querySelector("[data-add-question-form]"),
      addSubmit:      document.querySelector("[data-add-question-submit]"),
      addReset:       document.querySelector("[data-add-question-reset]"),
      addError:       document.querySelector("[data-add-question-error]"),
      qTypeSelect:    document.querySelector("[data-question-type]"),
      optionsWrap:    document.querySelector("[data-options-wrap]"),
      optionsActions: document.querySelector("[data-options-actions]"),
      addOptionBtn:   document.querySelector("[data-add-option]"),
      optionsMeta:    document.querySelector("[data-options-meta]"),
      qList:          document.querySelector("[data-questions-list]"),
      qCount:         document.querySelector("[data-questions-count]"),

      // Admin: users
      addUserForm:    document.querySelector("[data-add-user-form]"),
      addUserError:   document.querySelector("[data-add-user-error]"),
      usersList:      document.querySelector("[data-users-list]"),

      // Modals
      modalDq:        document.querySelector("[data-modal-delete-q]"),
      modalDqBody:    document.querySelector("[data-modal-dq-body]"),
      modalDqConfirm: document.querySelector("[data-modal-dq-confirm]"),
      modalDs:        document.querySelector("[data-modal-delete-sub]"),
      modalDsBody:    document.querySelector("[data-modal-ds-body]"),
      modalDsConfirm: document.querySelector("[data-modal-ds-confirm]"),
      modalReset:     document.querySelector("[data-modal-reset]"),
      modalResetInput:document.querySelector("[data-reset-confirm]"),
      modalResetError:document.querySelector("[data-modal-reset-error]"),
      modalResetConfirm: document.querySelector("[data-modal-reset-confirm]"),
      modalPassword:  document.querySelector("[data-modal-password]"),
      modalPwInput:   document.querySelector("[data-modal-pw-input]"),
      modalPwBody:    document.querySelector("[data-modal-pw-body]"),
      modalPwError:   document.querySelector("[data-modal-pw-error]"),
      modalPwConfirm: document.querySelector("[data-modal-pw-confirm]")
    };
  }

  // -------------------------------------------------------
  // Common top-bar buttons
  // -------------------------------------------------------
  function wireCommonButtons() {
    el.refreshBtn && el.refreshBtn.addEventListener("click", loadAll);
    el.exportBtn  && el.exportBtn.addEventListener("click", exportCsv);
    el.logoutBtn  && el.logoutBtn.addEventListener("click", () => {
      clearSession();
      window.location.replace("dashboard-access.html");
    });
    el.resetBtn && el.resetBtn.addEventListener("click", () => {
      if (!isAdmin()) return;
      el.modalResetInput.value = "";
      el.modalResetConfirm.disabled = true;
      el.modalResetError.textContent = "";
      openModal(el.modalReset);
      setTimeout(() => el.modalResetInput.focus(), 50);
    });
  }

  // -------------------------------------------------------
  // Filter bar
  // -------------------------------------------------------
  function initFilter() {
    const sel = el.filterSelect;
    sel.innerHTML = "";

    if (isAdmin()) {
      // Admin sees "All Users" + every non-admin user
      const all = document.createElement("option");
      all.value = "all"; all.textContent = "All Users";
      sel.appendChild(all);
      dashboardUsers
        .filter((u) => u.role === "user")
        .forEach((u) => {
          const o = document.createElement("option");
          o.value = u.id; o.textContent = u.display_name;
          sel.appendChild(o);
        });
      sel.disabled = false;
      currentFilter = "all";
    } else {
      // Normal user: only their own scope, locked
      const o = document.createElement("option");
      o.value = session.id; o.textContent = session.displayName;
      sel.appendChild(o);
      sel.disabled = true;
      currentFilter = session.id;
    }
    sel.value = currentFilter;
    updateFilterHint();

    sel.addEventListener("change", async () => {
      currentFilter = sel.value || "all";
      updateFilterHint();
      await loadAll();
    });
  }

  function updateFilterHint() {
    if (!el.filterHint) return;
    if (currentFilter === "all") {
      el.filterHint.textContent = "Showing data from every user.";
    } else {
      const match = dashboardUsers.find((u) => u.id === currentFilter);
      el.filterHint.textContent = match
        ? `Showing data tagged to ${match.display_name}.`
        : "Showing filtered data.";
    }
  }

  function currentFilterObject() { return { assignedUserId: currentFilter }; }

  // -------------------------------------------------------
  // Main loader
  // -------------------------------------------------------
  async function loadAll() {
    showLoading(true);
    el.errorBox.textContent = "";
    el.empty.classList.add("is-hidden");

    try {
      SP.db.invalidateCache();
      const filter = currentFilterObject();

      const [questions, agg, userRows, total] = await Promise.all([
        SP.db.getActiveQuestions(),
        SP.db.getAggregatedResults(filter),
        SP.db.getUserResponses(filter),
        SP.db.getTotalSubmissions(filter)
      ]);

      activeQuestions = questions;
      lastUserRows = userRows;
      el.total.textContent = String(total);

      if (isAdmin()) {
        renderAdminList(activeQuestions);
        renderUsersAdmin();
      }

      if (!total || !userRows.length) {
        el.aggregates.innerHTML = "";
        el.users.innerHTML = "";
        el.empty.classList.remove("is-hidden");
        tweakEmptyMessage();
      } else {
        renderAggregates(agg.questions);
        renderUsers(userRows, activeQuestions);
      }
    } catch (err) {
      console.error(err);
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard. Please try refreshing.");
    } finally {
      showLoading(false);
    }
  }

  function tweakEmptyMessage() {
    const h2 = el.empty.querySelector("h2");
    const p  = el.empty.querySelector("p");
    if (!h2 || !p) return;
    if (currentFilter !== "all") {
      const match = dashboardUsers.find((u) => u.id === currentFilter);
      h2.textContent = `No responses for ${match ? match.display_name : "this user"} yet`;
      p.textContent  = "Responses will show up here as they come in.";
    } else {
      h2.textContent = "No responses yet";
      p.textContent  = "Once users submit the poll, their results will show up here in real time.";
    }
  }

  function showLoading(on) { el.loading && el.loading.classList.toggle("is-hidden", !on); }

  // -------------------------------------------------------
  // Admin: add question form (dynamic options for MCQ)
  // -------------------------------------------------------
  function wireAdminForms() {
    if (!el.addForm) return;

    wireCounterFor("questionText", 150);

    el.qTypeSelect.addEventListener("change", refreshOptionFields);
    el.addOptionBtn.addEventListener("click", () => {
      const count = el.optionsWrap.querySelectorAll(".sp-option-field").length;
      if (count < LIMITS.OPTION_MAX) addOptionField("");
      renderOptionsMeta();
    });

    el.addReset && el.addReset.addEventListener("click", () => {
      el.addForm.reset();
      el.addError.textContent = "";
      refreshOptionFields();
      document.querySelector("[data-counter-for='questionText']").textContent = "0 / 150";
    });

    el.addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.addError.textContent = "";

      const fd = new FormData(el.addForm);
      const payload = {
        text: String(fd.get("questionText") || ""),
        type: String(fd.get("questionType") || "single_select"),
        required: fd.get("isRequired") === "on",
        options: Array.from(el.optionsWrap.querySelectorAll("input.sp-option-field__input")).map((n) => n.value)
      };

      el.addSubmit.disabled = true;
      const originalLabel = el.addSubmit.textContent;
      el.addSubmit.textContent = "Saving...";
      try {
        await SP.db.createQuestionWithOptions(payload);
        el.addForm.reset();
        refreshOptionFields();
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

    // User mgmt form
    if (el.addUserForm) {
      el.addUserForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        el.addUserError.textContent = "";
        const fd = new FormData(el.addUserForm);
        const displayName = String(fd.get("userName") || "").trim();
        const password    = String(fd.get("userPassword") || "");

        const submitBtn = el.addUserForm.querySelector("button[type='submit']");
        submitBtn.disabled = true;
        try {
          await SP.db.createDashboardUser({ displayName, password, role: "user" });
          el.addUserForm.reset();
          SP.utils.toast("User created.", "ok");
          dashboardUsers = await SP.db.listDashboardUsers();
          renderUsersAdmin();
          refreshFilterOptions();
        } catch (err) {
          console.error(err);
          el.addUserError.textContent = friendlyError(err, "Could not add user.");
        } finally {
          submitBtn.disabled = false;
        }
      });
    }

    refreshOptionFields();
  }

  function refreshFilterOptions() {
    if (!isAdmin()) return;
    const current = el.filterSelect.value;
    el.filterSelect.innerHTML = "";
    const all = document.createElement("option");
    all.value = "all"; all.textContent = "All Users";
    el.filterSelect.appendChild(all);
    dashboardUsers.filter((u) => u.role === "user").forEach((u) => {
      const o = document.createElement("option");
      o.value = u.id; o.textContent = u.display_name;
      el.filterSelect.appendChild(o);
    });
    el.filterSelect.value = dashboardUsers.find((u) => u.id === current) ? current : "all";
    currentFilter = el.filterSelect.value;
    updateFilterHint();
  }

  function wireCounterFor(name, max) {
    const input = el.addForm.querySelector(`[name='${name}']`);
    const counter = el.addForm.querySelector(`[data-counter-for='${name}']`);
    if (!input || !counter) return;
    const update = () => { counter.textContent = `${input.value.length} / ${max}`; };
    input.addEventListener("input", update); update();
  }

  function refreshOptionFields() {
    const type = el.qTypeSelect.value;
    el.optionsWrap.innerHTML = "";
    if (type === "text_input") {
      el.optionsActions.classList.add("is-hidden");
      el.optionsMeta.textContent = "";
      return;
    }
    el.optionsActions.classList.remove("is-hidden");
    addOptionField("");
    addOptionField("");
    renderOptionsMeta();
  }

  function addOptionField(value) {
    const current = el.optionsWrap.querySelectorAll(".sp-option-field").length;
    const idx = current + 1;
    const field = document.createElement("div");
    field.className = "sp-field sp-option-field";
    field.innerHTML = `
      <label class="sp-field__label">
        Option ${idx} <span class="sp-req">*</span>
        <span class="sp-counter" data-opt-counter>0 / 75</span>
      </label>
      <div class="sp-option-field__row">
        <input class="sp-input sp-option-field__input" type="text" maxlength="75"
               placeholder="Type option ${idx}" value="${SP.utils.escapeHtml(value || "")}" />
        <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm sp-option-field__remove" aria-label="Remove option">&times;</button>
      </div>
    `;
    const input = field.querySelector("input");
    const counter = field.querySelector("[data-opt-counter]");
    const update = () => { counter.textContent = `${input.value.length} / 75`; };
    input.addEventListener("input", update); update();

    field.querySelector(".sp-option-field__remove").addEventListener("click", () => {
      if (el.optionsWrap.querySelectorAll(".sp-option-field").length <= LIMITS.OPTION_MIN) {
        SP.utils.toast(`At least ${LIMITS.OPTION_MIN} options required.`, "error");
        return;
      }
      field.remove();
      reindexOptionLabels();
      renderOptionsMeta();
    });
    el.optionsWrap.appendChild(field);
    reindexOptionLabels();
  }

  function reindexOptionLabels() {
    const fields = el.optionsWrap.querySelectorAll(".sp-option-field");
    fields.forEach((f, i) => {
      const lab = f.querySelector(".sp-field__label");
      const cnt = f.querySelector("[data-opt-counter]");
      if (lab) lab.childNodes[0].nodeValue = `Option ${i + 1} `;
      const input = f.querySelector("input");
      if (input) input.placeholder = `Type option ${i + 1}`;
      if (cnt && input) cnt.textContent = `${input.value.length} / 75`;
    });
  }

  function renderOptionsMeta() {
    const count = el.optionsWrap.querySelectorAll(".sp-option-field").length;
    el.optionsMeta.textContent = `${count} / ${LIMITS.OPTION_MAX} options (min ${LIMITS.OPTION_MIN})`;
    el.addOptionBtn.disabled = count >= LIMITS.OPTION_MAX;
  }

  // -------------------------------------------------------
  // Admin: list + delete questions
  // -------------------------------------------------------
  function renderAdminList(questions) {
    el.qCount.textContent = String(questions.length);
    if (!questions.length) {
      el.qList.innerHTML = `<p class="sp-muted sp-admin__list-empty">No questions yet. Add your first above.</p>`;
      return;
    }
    el.qList.innerHTML = questions.map((q, i) => {
      const typeBadge = q.type === "text_input" ? "Text" : "MCQ";
      const reqBadge  = q.required ? `<span class="sp-pill sp-pill--req">Required</span>` : `<span class="sp-pill">Optional</span>`;
      const opts = q.options.length
        ? `<ul class="sp-q-row__opts">${q.options.map((o) => `<li class="sp-q-row__opt">${SP.utils.escapeHtml(o.text)}</li>`).join("")}</ul>`
        : `<p class="sp-muted">Free-text answer (up to 200 chars).</p>`;
      return `
        <article class="sp-q-row" data-q-id="${SP.utils.escapeHtml(q.id)}">
          <header class="sp-q-row__head">
            <span class="sp-q-row__num">Q${i + 1}</span>
            <h4 class="sp-q-row__text">${SP.utils.escapeHtml(q.text)}</h4>
            <button type="button" class="sp-btn sp-btn--danger sp-btn--sm"
                    data-delete-question="${SP.utils.escapeHtml(q.id)}">Delete</button>
          </header>
          <div class="sp-q-row__meta">
            <span class="sp-pill sp-pill--type">${typeBadge}</span>
            ${reqBadge}
          </div>
          ${opts}
        </article>`;
    }).join("");

    el.qList.querySelectorAll("[data-delete-question]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-delete-question");
        const q = activeQuestions.find((x) => x.id === id);
        const snippet = q ? (q.text.length > 80 ? q.text.slice(0, 80) + "..." : q.text) : "";
        el.modalDqBody.innerHTML = `Deleting <strong>"${SP.utils.escapeHtml(snippet)}"</strong> will remove it from the live poll and dashboard. Continue?`;
        pendingDeleteQId = id;
        openModal(el.modalDq);
      });
    });
  }

  // -------------------------------------------------------
  // Admin: list + manage users
  // -------------------------------------------------------
  function renderUsersAdmin() {
    if (!el.usersList) return;
    el.usersList.innerHTML = dashboardUsers.map((u) => {
      const isSelf = u.id === session.id;
      return `
        <article class="sp-user-admin" data-user-row-id="${SP.utils.escapeHtml(u.id)}">
          <div class="sp-user-admin__main">
            <span class="sp-user-admin__name" data-user-name>${SP.utils.escapeHtml(u.display_name)}</span>
            <span class="sp-pill sp-pill--${u.role === "admin" ? "req" : ""}">${u.role === "admin" ? "Admin" : "User"}</span>
            ${isSelf ? `<span class="sp-pill">You</span>` : ""}
          </div>
          <div class="sp-user-admin__actions">
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm" data-user-rename>Rename</button>
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm" data-user-password>Password</button>
            <button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-user-delete>Delete</button>
          </div>
        </article>`;
    }).join("");

    el.usersList.querySelectorAll("[data-user-rename]").forEach((btn) => {
      btn.addEventListener("click", () => renameUser(btn.closest("[data-user-row-id]")));
    });
    el.usersList.querySelectorAll("[data-user-password]").forEach((btn) => {
      btn.addEventListener("click", () => openPasswordModal(btn.closest("[data-user-row-id]")));
    });
    el.usersList.querySelectorAll("[data-user-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteUser(btn.closest("[data-user-row-id]")));
    });
  }

  async function renameUser(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id);
    if (!user) return;
    const next = window.prompt("New display name:", user.display_name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === user.display_name) return;
    try {
      await SP.db.renameDashboardUser(id, trimmed);
      SP.utils.toast("Renamed.", "ok");
      dashboardUsers = await SP.db.listDashboardUsers();
      renderUsersAdmin();
      refreshFilterOptions();
      await loadAll();
    } catch (err) {
      SP.utils.toast(friendlyError(err, "Could not rename."), "error");
    }
  }

  async function deleteUser(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id);
    if (!user) return;
    if (!window.confirm(`Deactivate "${user.display_name}"? Old responses are kept, but they cannot log in.`)) return;
    try {
      await SP.db.deleteDashboardUser(id);
      SP.utils.toast("User deactivated.", "ok");
      dashboardUsers = await SP.db.listDashboardUsers();
      renderUsersAdmin();
      refreshFilterOptions();
    } catch (err) {
      SP.utils.toast(friendlyError(err, "Could not deactivate."), "error");
    }
  }

  function openPasswordModal(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id);
    if (!user) return;
    pendingPasswordUserId = id;
    el.modalPwInput.value = "";
    el.modalPwError.textContent = "";
    el.modalPwBody.textContent = `Set a new password for ${user.display_name}.`;
    openModal(el.modalPassword);
    setTimeout(() => el.modalPwInput.focus(), 40);
  }

  // -------------------------------------------------------
  // Modals
  // -------------------------------------------------------
  function wireModals() {
    document.querySelectorAll("[data-modal-cancel]").forEach((n) => n.addEventListener("click", closeAllModals));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllModals(); });

    // Delete question
    el.modalDqConfirm && el.modalDqConfirm.addEventListener("click", async () => {
      if (!pendingDeleteQId) return;
      el.modalDqConfirm.disabled = true;
      el.modalDqConfirm.textContent = "Deleting...";
      try {
        await SP.db.softDeleteQuestion(pendingDeleteQId);
        SP.utils.toast("Question deleted.", "ok");
        closeAllModals();
        await loadAll();
      } catch (err) {
        SP.utils.toast(friendlyError(err, "Could not delete."), "error");
      } finally {
        el.modalDqConfirm.disabled = false;
        el.modalDqConfirm.textContent = "Delete";
      }
    });

    // Delete submission
    el.modalDsConfirm && el.modalDsConfirm.addEventListener("click", async () => {
      if (!pendingDeleteSubId) return;
      el.modalDsConfirm.disabled = true;
      el.modalDsConfirm.textContent = "Deleting...";
      try {
        await SP.db.deleteSubmission(pendingDeleteSubId);
        SP.utils.toast("Response deleted.", "ok");
        closeAllModals();
        await loadAll();
      } catch (err) {
        SP.utils.toast(friendlyError(err, "Could not delete."), "error");
      } finally {
        el.modalDsConfirm.disabled = false;
        el.modalDsConfirm.textContent = "Delete";
      }
    });

    // Reset
    if (el.modalResetInput) {
      el.modalResetInput.addEventListener("input", () => {
        el.modalResetConfirm.disabled = el.modalResetInput.value.trim() !== "RESET";
      });
    }
    el.modalResetConfirm && el.modalResetConfirm.addEventListener("click", async () => {
      if (el.modalResetInput.value.trim() !== "RESET") return;
      el.modalResetError.textContent = "";
      el.modalResetConfirm.disabled = true;
      el.modalResetConfirm.textContent = "Exporting...";
      try {
        // Step 1: export CSV of everything first (use a fresh unfiltered fetch so backup is complete)
        const backup = await SP.db.getUserResponses({ assignedUserId: "all" });
        const ok = downloadCsv(backup, activeQuestions, `swift-poll-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`);
        if (!ok) throw new Error("CSV backup failed");

        // Step 2: reset
        el.modalResetConfirm.textContent = "Resetting...";
        await SP.db.resetPollData();
        SP.utils.toast("Reset complete. A CSV backup was downloaded.", "ok");
        closeAllModals();
        activeQuestions = [];
        await loadAll();
      } catch (err) {
        console.error(err);
        el.modalResetError.textContent = friendlyError(err, "Reset failed. Nothing was deleted.");
      } finally {
        el.modalResetConfirm.disabled = false;
        el.modalResetConfirm.textContent = "Backup & Reset";
      }
    });

    // Change password
    el.modalPwConfirm && el.modalPwConfirm.addEventListener("click", async () => {
      if (!pendingPasswordUserId) return;
      const pw = (el.modalPwInput.value || "").trim();
      if (pw.length < 4) {
        el.modalPwError.textContent = "Password must be at least 4 characters.";
        return;
      }
      el.modalPwConfirm.disabled = true;
      el.modalPwConfirm.textContent = "Saving...";
      try {
        await SP.db.changeDashboardPassword(pendingPasswordUserId, pw);
        SP.utils.toast("Password changed.", "ok");
        closeAllModals();
      } catch (err) {
        el.modalPwError.textContent = friendlyError(err, "Could not change password.");
      } finally {
        el.modalPwConfirm.disabled = false;
        el.modalPwConfirm.textContent = "Save";
      }
    });
  }

  function openModal(node) { node.classList.remove("is-hidden"); }
  function closeAllModals() {
    document.querySelectorAll(".sp-modal").forEach((n) => n.classList.add("is-hidden"));
    pendingDeleteQId = pendingDeleteSubId = pendingPasswordUserId = null;
  }

  // -------------------------------------------------------
  // Aggregated results
  // -------------------------------------------------------
  function renderAggregates(questions) {
    if (!questions.length) { el.aggregates.innerHTML = ""; return; }
    el.aggregates.innerHTML = questions.map((q, qi) => {
      if (q.type === "text_input") {
        return `
          <article class="sp-agg-card">
            <header class="sp-agg-card__head">
              <span class="sp-agg-card__badge">Q${qi + 1}</span>
              <h3 class="sp-agg-card__title">${SP.utils.escapeHtml(q.text)}</h3>
            </header>
            <p class="sp-muted">Free-text question. See answers in the User-wise responses section below.</p>
            <footer class="sp-agg-card__foot">Total responses: <strong>${q.total || 0}</strong></footer>
          </article>`;
      }
      const total = q.total || 0;
      const optionsHtml = q.options.slice().sort((a, b) => (a.order - b.order) || a.text.localeCompare(b.text))
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
        }).join("");
      return `
        <article class="sp-agg-card">
          <header class="sp-agg-card__head">
            <span class="sp-agg-card__badge">Q${qi + 1}</span>
            <h3 class="sp-agg-card__title">${SP.utils.escapeHtml(q.text)}</h3>
          </header>
          <ul class="sp-bar-list">${optionsHtml}</ul>
          <footer class="sp-agg-card__foot">Total responses: <strong>${total}</strong></footer>
        </article>`;
    }).join("");
  }

  // -------------------------------------------------------
  // User-wise responses (with delete for admin, text answers supported)
  // -------------------------------------------------------
  function scopeFromSubmission(s) {
    return s.assigned?.display_name || dashboardUsers.find((u) => u.id === s.assigned_user_id)?.display_name || "-";
  }
  function answerValue(a, q) {
    if (!q) return "-";
    if (q.type === "text_input") return a.text_answer || "-";
    return a.selected_option_text || "-";
  }

  function renderUsers(submissions, questions) {
    const activeIds = new Set(questions.map((q) => q.id));
    const delCol = isAdmin() ? `<th aria-label="Actions"></th>` : "";
    const tableHead = `
      <thead>
        <tr>
          <th>User</th>
          <th>Scope</th>
          <th>Submitted</th>
          ${questions.map((q, i) => `<th title="${SP.utils.escapeHtml(q.text)}">Q${i + 1}</th>`).join("")}
          ${delCol}
        </tr>
      </thead>`;
    const rows = submissions.map((s) => {
      const answersByQ = {};
      (s.answers || []).forEach((a) => {
        if (a.question_id && activeIds.has(a.question_id)) answersByQ[a.question_id] = a;
      });
      const cells = questions.map((q) => `<td>${SP.utils.escapeHtml(answerValue(answersByQ[q.id] || {}, q))}</td>`).join("");
      const delBtn = isAdmin()
        ? `<td><button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-delete-sub="${SP.utils.escapeHtml(s.id)}">Delete</button></td>`
        : "";
      return `<tr>
        <td>${SP.utils.escapeHtml(s.user?.full_name || "Anonymous")}</td>
        <td class="sp-muted">${SP.utils.escapeHtml(scopeFromSubmission(s))}</td>
        <td class="sp-muted">${SP.utils.escapeHtml(SP.utils.formatDate(s.submitted_at))}</td>
        ${cells}
        ${delBtn}
      </tr>`;
    }).join("");

    const tableHtml = `<div class="sp-table-wrap"><table class="sp-table">${tableHead}<tbody>${rows}</tbody></table></div>`;

    const cardsHtml = submissions.map((s) => {
      const answersByQ = {};
      (s.answers || []).forEach((a) => {
        if (a.question_id && activeIds.has(a.question_id)) answersByQ[a.question_id] = a;
      });
      const items = questions.map((q, i) => `
        <li><span class="sp-user-card__q">Q${i + 1}.</span>
          <span class="sp-user-card__a">${SP.utils.escapeHtml(answerValue(answersByQ[q.id] || {}, q))}</span>
        </li>`).join("");
      const name  = s.user?.full_name || "Anonymous";
      const scope = scopeFromSubmission(s);
      const delBtn = isAdmin()
        ? `<button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-delete-sub="${SP.utils.escapeHtml(s.id)}">Delete</button>`
        : "";
      return `
        <article class="sp-user-card">
          <header class="sp-user-card__head">
            <div>
              <h4 class="sp-user-card__name">${SP.utils.escapeHtml(name)}</h4>
              <p class="sp-user-card__meta">${SP.utils.escapeHtml(scope)}</p>
            </div>
            <div class="sp-user-card__rhs">
              <time class="sp-user-card__time">${SP.utils.escapeHtml(SP.utils.formatDate(s.submitted_at))}</time>
              ${delBtn}
            </div>
          </header>
          <ul class="sp-user-card__answers">${items}</ul>
        </article>`;
    }).join("");

    el.users.innerHTML = `
      <div class="sp-users__desktop">${tableHtml}</div>
      <div class="sp-users__mobile">${cardsHtml}</div>`;

    if (isAdmin()) {
      el.users.querySelectorAll("[data-delete-sub]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-delete-sub");
          const s = lastUserRows.find((x) => x.id === id);
          const who = s?.user?.full_name || "this respondent";
          el.modalDsBody.textContent = `Delete the response from ${who}? This removes the submission and all its answers.`;
          pendingDeleteSubId = id;
          openModal(el.modalDs);
        });
      });
    }
  }

  // -------------------------------------------------------
  // CSV export (flattened: one row per answer)
  // -------------------------------------------------------
  function downloadCsv(submissions, questions, filename) {
    try {
      const header = ["Submission ID","Respondent","Scope","Submitted At","Question","Question Type","Answer"];
      const lines = [header.map(csvEscape).join(",")];
      const qById = {};
      questions.forEach((q) => { qById[q.id] = q; });
      for (const s of submissions) {
        const who   = s.user?.full_name || "Anonymous";
        const scope = scopeFromSubmission(s);
        const when  = SP.utils.formatDate(s.submitted_at);
        const answers = (s.answers || []).filter((a) => qById[a.question_id]);
        if (!answers.length) {
          lines.push([s.id, who, scope, when, "", "", ""].map(csvEscape).join(","));
          continue;
        }
        for (const a of answers) {
          const q = qById[a.question_id];
          lines.push([
            s.id, who, scope, when,
            q?.text || "",
            q?.type || "",
            answerValue(a, q)
          ].map(csvEscape).join(","));
        }
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch (e) { console.error(e); return false; }
  }

  function exportCsv() {
    if (!lastUserRows.length) { SP.utils.toast("No data to export yet.", "error"); return; }
    const scope = currentFilter === "all" ? "all" : currentFilter.slice(0, 8);
    downloadCsv(lastUserRows, activeQuestions, `swift-poll-${scope}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // -------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------
  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/Supabase URL not configured|Supabase client library not loaded/i.test(msg))
      return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/row-level security|RLS/i.test(msg)) return "Database blocked the write. Re-run supabase-schema.sql.";
    if (/Invalid API key|JWT|401/i.test(msg)) return "Invalid Supabase anon key.";
    if (/function .* does not exist/i.test(msg)) return "Database is out of date. Re-run supabase-schema.sql.";
    if (/relation .* does not exist/i.test(msg)) return "Database tables missing. Run supabase-schema.sql.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
