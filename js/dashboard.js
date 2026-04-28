/**
 * Swift Poll - dashboard controller (multi-poll).
 *
 * State:
 *   session        = { id, displayName, role } from sessionStorage
 *   accessiblePolls = polls visible to this session
 *   selectedPollId  = drives every read/write below it
 *   currentFilter   = "all" or dashboard_user.id for user-wise scope
 *
 * Admins see all polls and a full management surface. Normal users
 * see only their mapped polls and no management controls.
 */
(function () {
  const SESSION_KEY = "swift_poll.dashboard_session";
  const SELECTED_POLL_KEY = "swift_poll.selected_poll";

  let el = {};
  let session = null;
  let accessiblePolls = [];
  let selectedPollId = null;
  let selectedPoll = null;
  let currentFilter = "all";
  let dashboardUsers = [];
  let activeQuestions = [];
  let lastUserRows = [];
  let pendingDeleteQId = null;
  let pendingDeleteSubId = null;
  let pendingPasswordUserId = null;
  let pendingArchivePollId = null;
  let editingPollId = null;
  let visibilityPollId = null;
  let duplicatingPollId = null;

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
    wireCommon();
    wireAdminForms();
    wireModals();

    try {
      const [users, polls] = await Promise.all([
        SP.db.listDashboardUsers(),
        SP.db.listPollsForDashboardUser(session.id)
      ]);
      dashboardUsers = users;
      accessiblePolls = polls;
    } catch (err) {
      console.error(err);
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard.");
      return;
    }

    initPollSelector();
    initUserFilter();
    if (isAdmin()) await renderPollManagement();
    await loadAll();
  });

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

      pollSelect:     document.querySelector("[data-filter-poll]"),
      pollHint:       document.querySelector("[data-poll-hint]"),
      filterSelect:   document.querySelector("[data-filter-user]"),
      filterHint:     document.querySelector("[data-filter-hint]"),

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

      addUserForm:    document.querySelector("[data-add-user-form]"),
      addUserError:   document.querySelector("[data-add-user-error]"),
      usersList:      document.querySelector("[data-users-list]"),

      addPollForm:    document.querySelector("[data-add-poll-form]"),
      addPollError:   document.querySelector("[data-add-poll-error]"),
      pollsList:      document.querySelector("[data-polls-list]"),

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
      modalPwConfirm: document.querySelector("[data-modal-pw-confirm]"),

      modalVis:       document.querySelector("[data-modal-visibility]"),
      modalVisBody:   document.querySelector("[data-modal-vis-body]"),
      modalVisList:   document.querySelector("[data-modal-vis-list]"),

      modalEp:        document.querySelector("[data-modal-edit-poll]"),
      modalEpTitle:   document.querySelector("[data-modal-ep-title]"),
      modalEpDesc:    document.querySelector("[data-modal-ep-description]"),
      modalEpStatus:  document.querySelector("[data-modal-ep-status]"),
      modalEpError:   document.querySelector("[data-modal-ep-error]"),
      modalEpSave:    document.querySelector("[data-modal-ep-save]"),

      modalDup:       document.querySelector("[data-modal-duplicate]"),
      modalDupTitle:  document.querySelector("[data-modal-dup-title]"),
      modalDupSlug:   document.querySelector("[data-modal-dup-slug]"),
      modalDupError:  document.querySelector("[data-modal-dup-error]"),
      modalDupConfirm:document.querySelector("[data-modal-dup-confirm]"),

      modalAp:        document.querySelector("[data-modal-archive-poll]"),
      modalApBody:    document.querySelector("[data-modal-ap-body]"),
      modalApConfirm: document.querySelector("[data-modal-ap-confirm]")
    };
  }

  // -------------------------------------------------------
  function readSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_) { return null; } }
  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }
  function isAdmin() { return session && session.role === "admin"; }
  function showWho() { el.who && (el.who.textContent = `${session.displayName} (${isAdmin() ? "Admin" : "User"})`); }
  function applyRoleVisibility() {
    document.querySelectorAll("[data-admin-only]").forEach((n) => n.classList.toggle("is-hidden", !isAdmin()));
  }

  function wireCommon() {
    el.refreshBtn && el.refreshBtn.addEventListener("click", loadAll);
    el.exportBtn  && el.exportBtn.addEventListener("click", exportCsv);
    el.logoutBtn && el.logoutBtn.addEventListener("click", async () => {
      const tok = session && session.token;
      clearSession();
      try { if (tok) await SP.db.logoutDashboardUser(tok); } catch (_) {}
      window.location.replace("dashboard-access.html");
    });
    el.resetBtn && el.resetBtn.addEventListener("click", () => {
      if (!isAdmin() || !selectedPollId) return;
      el.modalResetInput.value = "";
      el.modalResetConfirm.disabled = true;
      el.modalResetError.textContent = "";
      openModal(el.modalReset);
      setTimeout(() => el.modalResetInput.focus(), 50);
    });
  }

  // -------------------------------------------------------
  // Poll selector
  // -------------------------------------------------------
  function initPollSelector() {
    el.pollSelect.innerHTML = "";
    if (!accessiblePolls.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No polls available";
      el.pollSelect.appendChild(opt);
      el.pollSelect.disabled = true;
      el.pollHint.textContent = isAdmin()
        ? "Create a poll below to get started."
        : "No polls are assigned to your account yet.";
      selectedPollId = null; selectedPoll = null;
      return;
    }

    accessiblePolls.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      const tag = p.status && p.status !== "active" ? ` (${p.status})` : "";
      o.textContent = p.title + tag;
      el.pollSelect.appendChild(o);
    });

    const stored = sessionStorage.getItem(SELECTED_POLL_KEY);
    const fromStored = accessiblePolls.find((p) => p.id === stored);
    selectedPoll = fromStored || accessiblePolls[0];
    selectedPollId = selectedPoll.id;
    el.pollSelect.value = selectedPollId;
    updatePollHint();

    el.pollSelect.addEventListener("change", async () => {
      selectedPollId = el.pollSelect.value;
      selectedPoll = accessiblePolls.find((p) => p.id === selectedPollId);
      sessionStorage.setItem(SELECTED_POLL_KEY, selectedPollId);
      updatePollHint();
      await loadAll();
    });
  }

  function updatePollHint() {
    if (!el.pollHint) return;
    if (!selectedPoll) { el.pollHint.textContent = ""; return; }
    const desc = selectedPoll.description ? ` ${selectedPoll.description}` : "";
    el.pollHint.textContent = `${selectedPoll.slug}${desc}`;
  }

  function initUserFilter() {
    const sel = el.filterSelect;
    sel.innerHTML = "";
    if (isAdmin()) {
      const all = document.createElement("option"); all.value = "all"; all.textContent = "All Users";
      sel.appendChild(all);
      dashboardUsers.filter((u) => u.role === "user").forEach((u) => {
        const o = document.createElement("option"); o.value = u.id; o.textContent = u.display_name;
        sel.appendChild(o);
      });
      sel.disabled = false; currentFilter = "all";
    } else {
      const o = document.createElement("option"); o.value = session.id; o.textContent = session.displayName;
      sel.appendChild(o);
      sel.disabled = true; currentFilter = session.id;
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
    if (currentFilter === "all") { el.filterHint.textContent = "Showing data from every user."; return; }
    const match = dashboardUsers.find((u) => u.id === currentFilter);
    el.filterHint.textContent = match ? `Showing data tagged to ${match.display_name}.` : "";
  }

  function filterArgs() { return { pollId: selectedPollId, assignedUserId: currentFilter }; }

  // -------------------------------------------------------
  // Main loader
  // -------------------------------------------------------
  async function loadAll() {
    if (!selectedPollId) {
      el.total.textContent = "-";
      el.aggregates.innerHTML = "";
      el.users.innerHTML = "";
      el.empty.classList.remove("is-hidden");
      if (isAdmin()) renderAdminList([]);
      return;
    }
    showLoading(true);
    el.errorBox.textContent = "";
    el.empty.classList.add("is-hidden");

    try {
      SP.db.invalidateCache(selectedPollId);
      const filter = filterArgs();
      const [questions, agg, userRows, total] = await Promise.all([
        SP.db.getActiveQuestions(selectedPollId),
        SP.db.getAggregatedResults(filter),
        SP.db.getUserResponses(filter),
        SP.db.getTotalSubmissions(filter)
      ]);
      activeQuestions = questions;
      lastUserRows = userRows;
      el.total.textContent = String(total);
      if (isAdmin()) { renderAdminList(activeQuestions); renderUsersAdmin(); }
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
      el.errorBox.textContent = friendlyError(err, "Could not load dashboard.");
    } finally {
      showLoading(false);
    }
  }

  function tweakEmptyMessage() {
    const h2 = el.empty.querySelector("h2"); const p = el.empty.querySelector("p");
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
  // Admin: questions (scoped to selected poll)
  // -------------------------------------------------------
  function wireAdminForms() {
    if (!el.addForm) return;
    wireCounterFor("questionText", 150);
    el.qTypeSelect.addEventListener("change", refreshOptionFields);
    el.addOptionBtn.addEventListener("click", () => {
      const count = el.optionsWrap.querySelectorAll(".sp-option-field").length;
      if (count < SP.db.LIMITS.OPTION_MAX) addOptionField("");
      renderOptionsMeta();
    });
    el.addReset && el.addReset.addEventListener("click", () => {
      el.addForm.reset(); el.addError.textContent = "";
      refreshOptionFields();
      const c = document.querySelector("[data-counter-for='questionText']");
      if (c) c.textContent = "0 / 150";
    });

    el.addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.addError.textContent = "";
      if (!selectedPollId) { el.addError.textContent = "Select a poll first."; return; }
      const fd = new FormData(el.addForm);
      const payload = {
        pollId: selectedPollId,
        text: String(fd.get("questionText") || ""),
        type: String(fd.get("questionType") || "single_select"),
        required: fd.get("isRequired") === "on",
        options: Array.from(el.optionsWrap.querySelectorAll("input.sp-option-field__input")).map((n) => n.value)
      };
      el.addSubmit.disabled = true;
      const original = el.addSubmit.textContent; el.addSubmit.textContent = "Saving...";
      try {
        await SP.db.createQuestionWithOptions(payload);
        el.addForm.reset(); refreshOptionFields();
        SP.utils.toast("Question added.", "ok");
        await loadAll();
        if (isAdmin()) renderPollManagement();
      } catch (err) {
        const errors = (err && err.validation) || [err?.message || "Could not save."];
        el.addError.innerHTML = errors.map((m) => `&bull; ${SP.utils.escapeHtml(m)}`).join("<br>");
      } finally {
        el.addSubmit.disabled = false;
        el.addSubmit.textContent = original || "Add Question";
      }
    });

    if (el.addUserForm) {
      el.addUserForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        el.addUserError.textContent = "";
        const fd = new FormData(el.addUserForm);
        const displayName = String(fd.get("userName") || "").trim();
        const password    = String(fd.get("userPassword") || "");
        const btn = el.addUserForm.querySelector("button[type='submit']"); btn.disabled = true;
        try {
          await SP.db.createDashboardUser({ displayName, password, role: "user" });
          el.addUserForm.reset();
          SP.utils.toast("User created.", "ok");
          dashboardUsers = await SP.db.listDashboardUsers();
          renderUsersAdmin(); refreshFilterOptions();
          if (isAdmin()) renderPollManagement();
        } catch (err) {
          el.addUserError.textContent = friendlyError(err, "Could not add user.");
        } finally { btn.disabled = false; }
      });
    }

    if (el.addPollForm) {
      el.addPollForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        el.addPollError.textContent = "";
        const fd = new FormData(el.addPollForm);
        const payload = {
          title: String(fd.get("pollTitle") || ""),
          slug:  String(fd.get("pollSlug") || ""),
          description: String(fd.get("pollDescription") || ""),
          isActive: true
        };
        const btn = el.addPollForm.querySelector("button[type='submit']"); btn.disabled = true;
        try {
          const newPoll = await SP.db.createPoll(payload);
          el.addPollForm.reset();
          SP.utils.toast("Poll created.", "ok");
          accessiblePolls = await SP.db.listPollsForDashboardUser(session.id);
          rebuildPollSelector(newPoll.id);
          await renderPollManagement();
          await loadAll();
        } catch (err) {
          const errors = (err && err.validation) || [err?.message || "Could not create poll."];
          el.addPollError.innerHTML = errors.map((m) => `&bull; ${SP.utils.escapeHtml(m)}`).join("<br>");
        } finally { btn.disabled = false; }
      });
    }

    refreshOptionFields();
  }

  function rebuildPollSelector(preferredPollId) {
    el.pollSelect.innerHTML = "";
    el.pollSelect.disabled = accessiblePolls.length === 0;
    accessiblePolls.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      const tag = p.status && p.status !== "active" ? ` (${p.status})` : "";
      o.textContent = p.title + tag;
      el.pollSelect.appendChild(o);
    });
    const next = accessiblePolls.find((p) => p.id === preferredPollId)
              || accessiblePolls.find((p) => p.id === selectedPollId)
              || accessiblePolls[0]
              || null;
    if (next) {
      selectedPoll = next; selectedPollId = next.id;
      el.pollSelect.value = selectedPollId;
      sessionStorage.setItem(SELECTED_POLL_KEY, selectedPollId);
    } else {
      selectedPoll = null; selectedPollId = null;
    }
    updatePollHint();
  }

  function refreshFilterOptions() {
    if (!isAdmin()) return;
    const current = el.filterSelect.value;
    el.filterSelect.innerHTML = "";
    const all = document.createElement("option"); all.value = "all"; all.textContent = "All Users";
    el.filterSelect.appendChild(all);
    dashboardUsers.filter((u) => u.role === "user").forEach((u) => {
      const o = document.createElement("option"); o.value = u.id; o.textContent = u.display_name;
      el.filterSelect.appendChild(o);
    });
    el.filterSelect.value = dashboardUsers.find((u) => u.id === current) ? current : "all";
    currentFilter = el.filterSelect.value; updateFilterHint();
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
      el.optionsActions.classList.add("is-hidden"); el.optionsMeta.textContent = ""; return;
    }
    el.optionsActions.classList.remove("is-hidden");
    addOptionField(""); addOptionField(""); renderOptionsMeta();
  }

  function addOptionField(value) {
    const idx = el.optionsWrap.querySelectorAll(".sp-option-field").length + 1;
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
      </div>`;
    const input = field.querySelector("input");
    const counter = field.querySelector("[data-opt-counter]");
    const upd = () => { counter.textContent = `${input.value.length} / 75`; };
    input.addEventListener("input", upd); upd();
    field.querySelector(".sp-option-field__remove").addEventListener("click", () => {
      if (el.optionsWrap.querySelectorAll(".sp-option-field").length <= SP.db.LIMITS.OPTION_MIN) {
        SP.utils.toast(`At least ${SP.db.LIMITS.OPTION_MIN} options required.`, "error");
        return;
      }
      field.remove(); reindexOptionLabels(); renderOptionsMeta();
    });
    el.optionsWrap.appendChild(field); reindexOptionLabels();
  }

  function reindexOptionLabels() {
    el.optionsWrap.querySelectorAll(".sp-option-field").forEach((f, i) => {
      const lab = f.querySelector(".sp-field__label");
      const cnt = f.querySelector("[data-opt-counter]");
      if (lab) lab.childNodes[0].nodeValue = `Option ${i + 1} `;
      const inp = f.querySelector("input");
      if (inp) inp.placeholder = `Type option ${i + 1}`;
      if (cnt && inp) cnt.textContent = `${inp.value.length} / 75`;
    });
  }
  function renderOptionsMeta() {
    const count = el.optionsWrap.querySelectorAll(".sp-option-field").length;
    el.optionsMeta.textContent = `${count} / ${SP.db.LIMITS.OPTION_MAX} options (min ${SP.db.LIMITS.OPTION_MIN})`;
    el.addOptionBtn.disabled = count >= SP.db.LIMITS.OPTION_MAX;
  }

  // -------------------------------------------------------
  // Admin: questions list
  // -------------------------------------------------------
  function renderAdminList(questions) {
    if (!el.qList) return;
    el.qCount.textContent = String(questions.length);
    if (!questions.length) {
      el.qList.innerHTML = `<p class="sp-muted sp-admin__list-empty">No questions yet for this poll.</p>`;
      return;
    }
    el.qList.innerHTML = questions.map((q, i) => {
      const typeBadge = q.type === "text_input" ? "Text" : "MCQ";
      const reqBadge  = q.required ? `<span class="sp-pill sp-pill--req">Required</span>` : `<span class="sp-pill">Optional</span>`;
      const opts = q.options.length
        ? `<ul class="sp-q-row__opts">${q.options.map((o) => `<li class="sp-q-row__opt">${SP.utils.escapeHtml(o.text)}</li>`).join("")}</ul>`
        : `<p class="sp-muted">Free-text answer (up to 300 chars).</p>`;
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
  // Admin: users list
  // -------------------------------------------------------
  function renderUsersAdmin() {
    if (!el.usersList) return;
    el.usersList.innerHTML = dashboardUsers.map((u) => {
      const isSelf = u.id === session.id;
      return `
        <article class="sp-user-admin" data-user-row-id="${SP.utils.escapeHtml(u.id)}">
          <div class="sp-user-admin__main">
            <span class="sp-user-admin__name">${SP.utils.escapeHtml(u.display_name)}</span>
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
    el.usersList.querySelectorAll("[data-user-rename]").forEach((b) => b.addEventListener("click", () => renameUser(b.closest("[data-user-row-id]"))));
    el.usersList.querySelectorAll("[data-user-password]").forEach((b) => b.addEventListener("click", () => openPasswordModal(b.closest("[data-user-row-id]"))));
    el.usersList.querySelectorAll("[data-user-delete]").forEach((b) => b.addEventListener("click", () => deleteUser(b.closest("[data-user-row-id]"))));
  }

  async function renameUser(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id);
    if (!user) return;
    const next = window.prompt("New display name:", user.display_name);
    if (next == null) return;
    const t = next.trim(); if (!t || t === user.display_name) return;
    try {
      await SP.db.renameDashboardUser(id, t);
      SP.utils.toast("Renamed.", "ok");
      dashboardUsers = await SP.db.listDashboardUsers();
      renderUsersAdmin(); refreshFilterOptions(); await loadAll();
    } catch (err) { SP.utils.toast(friendlyError(err, "Could not rename."), "error"); }
  }
  async function deleteUser(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id); if (!user) return;
    if (!window.confirm(`Deactivate "${user.display_name}"? Old responses are kept.`)) return;
    try {
      await SP.db.deleteDashboardUser(id);
      SP.utils.toast("User deactivated.", "ok");
      dashboardUsers = await SP.db.listDashboardUsers();
      renderUsersAdmin(); refreshFilterOptions();
      if (isAdmin()) renderPollManagement();
    } catch (err) { SP.utils.toast(friendlyError(err, "Could not deactivate."), "error"); }
  }
  function openPasswordModal(row) {
    const id = row.getAttribute("data-user-row-id");
    const user = dashboardUsers.find((u) => u.id === id); if (!user) return;
    pendingPasswordUserId = id;
    el.modalPwInput.value = "";
    el.modalPwError.textContent = "";
    el.modalPwBody.textContent = `Set a new password for ${user.display_name}.`;
    openModal(el.modalPassword);
    setTimeout(() => el.modalPwInput.focus(), 40);
  }

  // -------------------------------------------------------
  // Admin: poll management
  // -------------------------------------------------------
  async function renderPollManagement() {
    if (!el.pollsList) return;
    // Admin sees every non-deleted poll (including inactive) for management
    const all = await SP.db.listAllPolls();
    if (!all.length) {
      el.pollsList.innerHTML = `<p class="sp-muted sp-admin__list-empty">No polls yet. Create one above.</p>`;
      return;
    }

    // Fetch stats in parallel
    const stats = await Promise.all(all.map((p) => SP.db.getPollStats(p.id).catch(() => ({}))));

    el.pollsList.innerHTML = all.map((p, i) => {
      const s = stats[i] || {};
      const statusLabel = (p.status || "draft");
      const statusPill  = `<span class="sp-pill sp-status sp-status--${statusLabel}">${statusLabel[0].toUpperCase() + statusLabel.slice(1)}</span>`;
      const isArchived  = statusLabel === "archived";
      const archiveLabel = isArchived ? "Unarchive" : "Archive";
      return `
        <article class="sp-poll-row" data-poll-row-id="${SP.utils.escapeHtml(p.id)}">
          <header class="sp-poll-row__head">
            <div class="sp-poll-row__title">
              <h4>${SP.utils.escapeHtml(p.title)}</h4>
              <span class="sp-muted">${SP.utils.escapeHtml(p.slug)}</span>
            </div>
            ${statusPill}
          </header>
          ${p.description ? `<p class="sp-muted sp-poll-row__desc">${SP.utils.escapeHtml(p.description)}</p>` : ""}
          <div class="sp-poll-row__stats">
            <span><strong>${s.questionCount || 0}</strong> questions</span>
            <span><strong>${s.accessCount || 0}</strong> users assigned</span>
            <span><strong>${s.submissionCount || 0}</strong> submissions</span>
          </div>
          <div class="sp-poll-row__actions">
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm" data-poll-visibility>Visibility</button>
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm" data-poll-edit>Edit</button>
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm" data-poll-duplicate>Duplicate</button>
            <button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-poll-archive>${archiveLabel}</button>
          </div>
        </article>`;
    }).join("");

    el.pollsList.querySelectorAll("[data-poll-visibility]").forEach((b) => b.addEventListener("click", () => openVisibilityModal(b.closest("[data-poll-row-id]").getAttribute("data-poll-row-id"))));
    el.pollsList.querySelectorAll("[data-poll-edit]").forEach((b) => b.addEventListener("click", () => openEditPollModal(b.closest("[data-poll-row-id]").getAttribute("data-poll-row-id"))));
    el.pollsList.querySelectorAll("[data-poll-duplicate]").forEach((b) => b.addEventListener("click", () => openDuplicateModal(b.closest("[data-poll-row-id]").getAttribute("data-poll-row-id"))));
    el.pollsList.querySelectorAll("[data-poll-archive]").forEach((b) => b.addEventListener("click", () => openArchiveModal(b.closest("[data-poll-row-id]").getAttribute("data-poll-row-id"))));
  }

  async function openDuplicateModal(pollId) {
    duplicatingPollId = pollId;
    const poll = (await SP.db.listAllPolls()).find((p) => p.id === pollId);
    if (!poll) return;
    el.modalDupTitle.value = `${poll.title} (Copy)`;
    el.modalDupSlug.value  = `${poll.slug}-copy`;
    el.modalDupError.textContent = "";
    openModal(el.modalDup);
    setTimeout(() => el.modalDupSlug.focus(), 40);
  }

  async function openVisibilityModal(pollId) {
    visibilityPollId = pollId;
    const poll = (await SP.db.listAllPolls()).find((p) => p.id === pollId);
    el.modalVisBody.textContent = `Toggle which users can access "${poll?.title || "this poll"}".`;
    const map = await SP.db.getPollAccessMap(pollId);
    const users = dashboardUsers.filter((u) => u.role === "user" && u.is_active);
    el.modalVisList.innerHTML = users.length
      ? users.map((u) => {
          const on = map.get(u.id) === true;
          return `
            <label class="sp-vis-row">
              <span class="sp-vis-row__name">${SP.utils.escapeHtml(u.display_name)}</span>
              <span class="sp-switch sp-switch--compact">
                <input type="checkbox" data-vis-user="${SP.utils.escapeHtml(u.id)}" ${on ? "checked" : ""} />
                <span class="sp-switch__track" aria-hidden="true"></span>
              </span>
            </label>`;
        }).join("")
      : `<p class="sp-muted">No active users.</p>`;
    openModal(el.modalVis);

    el.modalVisList.querySelectorAll("[data-vis-user]").forEach((chk) => {
      chk.addEventListener("change", async () => {
        const uid = chk.getAttribute("data-vis-user");
        const enabled = chk.checked;
        chk.disabled = true;
        try {
          await SP.db.setPollUserAccess(visibilityPollId, uid, enabled);
          SP.utils.toast(enabled ? "Access granted." : "Access removed.", "ok");
          // Refresh our accessiblePolls so selector reflects any changes for self
          accessiblePolls = await SP.db.listPollsForDashboardUser(session.id);
          if (!accessiblePolls.some((p) => p.id === selectedPollId)) {
            rebuildPollSelector();
            await loadAll();
          }
          renderPollManagement();
        } catch (err) {
          SP.utils.toast(friendlyError(err, "Could not update access."), "error");
          chk.checked = !enabled;
        } finally { chk.disabled = false; }
      });
    });
  }

  async function openEditPollModal(pollId) {
    editingPollId = pollId;
    const poll = (await SP.db.listAllPolls()).find((p) => p.id === pollId);
    if (!poll) return;
    el.modalEpTitle.value  = poll.title;
    el.modalEpDesc.value   = poll.description || "";
    el.modalEpStatus.value = poll.status || "draft";
    el.modalEpError.textContent = "";
    openModal(el.modalEp);
    setTimeout(() => el.modalEpTitle.focus(), 40);
  }

  function openArchiveModal(pollId) {
    pendingArchivePollId = pollId;
    openModal(el.modalAp);
  }

  // -------------------------------------------------------
  // Modals
  // -------------------------------------------------------
  function wireModals() {
    document.querySelectorAll("[data-modal-cancel]").forEach((n) => n.addEventListener("click", closeAllModals));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllModals(); });

    el.modalDqConfirm && el.modalDqConfirm.addEventListener("click", async () => {
      if (!pendingDeleteQId) return;
      el.modalDqConfirm.disabled = true; el.modalDqConfirm.textContent = "Deleting...";
      try {
        await SP.db.softDeleteQuestion(pendingDeleteQId, selectedPollId);
        SP.utils.toast("Question deleted.", "ok");
        closeAllModals(); await loadAll();
        if (isAdmin()) renderPollManagement();
      } catch (err) { SP.utils.toast(friendlyError(err, "Could not delete."), "error"); }
      finally { el.modalDqConfirm.disabled = false; el.modalDqConfirm.textContent = "Delete"; }
    });

    el.modalDsConfirm && el.modalDsConfirm.addEventListener("click", async () => {
      if (!pendingDeleteSubId) return;
      el.modalDsConfirm.disabled = true; el.modalDsConfirm.textContent = "Deleting...";
      try {
        await SP.db.deleteSubmission(pendingDeleteSubId);
        SP.utils.toast("Response deleted.", "ok");
        closeAllModals(); await loadAll();
        if (isAdmin()) renderPollManagement();
      } catch (err) { SP.utils.toast(friendlyError(err, "Could not delete."), "error"); }
      finally { el.modalDsConfirm.disabled = false; el.modalDsConfirm.textContent = "Delete"; }
    });

    if (el.modalResetInput) {
      el.modalResetInput.addEventListener("input", () => {
        el.modalResetConfirm.disabled = el.modalResetInput.value.trim() !== "RESET";
      });
    }
    el.modalResetConfirm && el.modalResetConfirm.addEventListener("click", async () => {
      if (el.modalResetInput.value.trim() !== "RESET" || !selectedPollId) return;
      el.modalResetError.textContent = "";
      el.modalResetConfirm.disabled = true;
      el.modalResetConfirm.textContent = "Exporting...";
      try {
        const backup = await SP.db.getUserResponses({ pollId: selectedPollId, assignedUserId: "all" });
        const qs     = await SP.db.getActiveQuestions(selectedPollId);
        const ok = downloadCsv(backup, qs, `swift-poll-${selectedPoll?.slug || "poll"}-backup-${stamp()}.csv`);
        if (!ok) throw new Error("CSV backup failed");
        el.modalResetConfirm.textContent = "Resetting...";
        await SP.db.resetPollData(selectedPollId);
        SP.utils.toast("Reset complete. CSV downloaded.", "ok");
        closeAllModals();
        SP.db.invalidateCache(selectedPollId);
        await loadAll();
        if (isAdmin()) renderPollManagement();
      } catch (err) {
        el.modalResetError.textContent = friendlyError(err, "Reset failed. Nothing was deleted.");
      } finally {
        el.modalResetConfirm.disabled = false;
        el.modalResetConfirm.textContent = "Backup & Reset";
      }
    });

    el.modalPwConfirm && el.modalPwConfirm.addEventListener("click", async () => {
      if (!pendingPasswordUserId) return;
      const pw = (el.modalPwInput.value || "").trim();
      if (pw.length < 4) { el.modalPwError.textContent = "Password must be at least 4 characters."; return; }
      el.modalPwConfirm.disabled = true; el.modalPwConfirm.textContent = "Saving...";
      try {
        await SP.db.changeDashboardPassword(pendingPasswordUserId, pw);
        SP.utils.toast("Password changed.", "ok");
        closeAllModals();
      } catch (err) { el.modalPwError.textContent = friendlyError(err, "Could not change password."); }
      finally { el.modalPwConfirm.disabled = false; el.modalPwConfirm.textContent = "Save"; }
    });

    el.modalEpSave && el.modalEpSave.addEventListener("click", async () => {
      if (!editingPollId) return;
      el.modalEpError.textContent = "";
      el.modalEpSave.disabled = true;
      try {
        await SP.db.updatePoll(editingPollId, {
          title: el.modalEpTitle.value,
          description: el.modalEpDesc.value,
          status: el.modalEpStatus.value
        });
        SP.utils.toast("Poll saved.", "ok");
        closeAllModals();
        accessiblePolls = await SP.db.listPollsForDashboardUser(session.id);
        rebuildPollSelector();
        await renderPollManagement();
        await loadAll();
      } catch (err) { el.modalEpError.textContent = friendlyError(err, "Could not save."); }
      finally { el.modalEpSave.disabled = false; }
    });

    el.modalApConfirm && el.modalApConfirm.addEventListener("click", async () => {
      if (!pendingArchivePollId) return;
      el.modalApConfirm.disabled = true; el.modalApConfirm.textContent = "Archiving...";
      try {
        const all = await SP.db.listAllPolls();
        const poll = all.find((p) => p.id === pendingArchivePollId);
        const nextStatus = poll && poll.status === "archived" ? "draft" : "archived";
        await SP.db.updatePoll(pendingArchivePollId, {
          title: null, description: null, status: nextStatus
        });
        SP.utils.toast(nextStatus === "archived" ? "Poll archived." : "Poll unarchived (Draft).", "ok");
        closeAllModals();
        accessiblePolls = await SP.db.listPollsForDashboardUser(session.id);
        rebuildPollSelector();
        await renderPollManagement();
        await loadAll();
      } catch (err) { SP.utils.toast(friendlyError(err, "Could not change status."), "error"); }
      finally { el.modalApConfirm.disabled = false; el.modalApConfirm.textContent = "Archive"; }
    });

    el.modalDupConfirm && el.modalDupConfirm.addEventListener("click", async () => {
      if (!duplicatingPollId) return;
      el.modalDupError.textContent = "";
      el.modalDupConfirm.disabled = true;
      el.modalDupConfirm.textContent = "Duplicating...";
      try {
        const newId = await SP.db.duplicatePoll(duplicatingPollId, {
          newSlug: el.modalDupSlug.value, newTitle: el.modalDupTitle.value
        });
        SP.utils.toast("Poll duplicated as Draft.", "ok");
        closeAllModals();
        accessiblePolls = await SP.db.listPollsForDashboardUser(session.id);
        rebuildPollSelector(newId);
        await renderPollManagement();
        await loadAll();
      } catch (err) {
        el.modalDupError.textContent = friendlyError(err, "Could not duplicate.");
      } finally {
        el.modalDupConfirm.disabled = false;
        el.modalDupConfirm.textContent = "Duplicate";
      }
    });
  }

  function openModal(node) { node.classList.remove("is-hidden"); }
  function closeAllModals() {
    document.querySelectorAll(".sp-modal").forEach((n) => n.classList.add("is-hidden"));
    pendingDeleteQId = pendingDeleteSubId = pendingPasswordUserId = pendingArchivePollId = null;
    editingPollId = visibilityPollId = duplicatingPollId = null;
  }

  // -------------------------------------------------------
  // Aggregated results (solid colors per option index)
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
            <p class="sp-muted">Free-text question. See answers in User-wise responses.</p>
            <footer class="sp-agg-card__foot">Total responses: <strong>${q.total || 0}</strong></footer>
          </article>`;
      }
      const total = q.total || 0;
      const sortedOpts = q.options.slice().sort((a, b) => (a.order - b.order) || a.text.localeCompare(b.text));
      const optionsHtml = sortedOpts.map((o, oi) => {
        const pct = total > 0 ? Math.round((o.count / total) * 100) : 0;
        return `
          <li class="sp-bar">
            <div class="sp-bar__head">
              <span class="sp-bar__label">${SP.utils.escapeHtml(o.text)}</span>
              <span class="sp-bar__val">${o.count} <span class="sp-bar__pct">(${pct}%)</span></span>
            </div>
            <div class="sp-bar__track" aria-hidden="true">
              <div class="sp-bar__fill sp-bar__fill--i${oi % 5}" style="width:${pct}%"></div>
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
  // User-wise responses
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
      const byQ = {};
      (s.answers || []).forEach((a) => { if (a.question_id && activeIds.has(a.question_id)) byQ[a.question_id] = a; });
      const cells = questions.map((q) => `<td>${SP.utils.escapeHtml(answerValue(byQ[q.id] || {}, q))}</td>`).join("");
      const delBtn = isAdmin() ? `<td><button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-delete-sub="${SP.utils.escapeHtml(s.id)}">Delete</button></td>` : "";
      return `<tr>
        <td>${SP.utils.escapeHtml(s.user?.full_name || "Anonymous")}</td>
        <td class="sp-muted">${SP.utils.escapeHtml(scopeFromSubmission(s))}</td>
        <td class="sp-muted">${SP.utils.escapeHtml(SP.utils.formatDate(s.submitted_at))}</td>
        ${cells}${delBtn}
      </tr>`;
    }).join("");
    const tableHtml = `<div class="sp-table-wrap"><table class="sp-table">${tableHead}<tbody>${rows}</tbody></table></div>`;

    const cardsHtml = submissions.map((s) => {
      const byQ = {};
      (s.answers || []).forEach((a) => { if (a.question_id && activeIds.has(a.question_id)) byQ[a.question_id] = a; });
      const items = questions.map((q, i) => `
        <li><span class="sp-user-card__q">Q${i + 1}.</span>
          <span class="sp-user-card__a">${SP.utils.escapeHtml(answerValue(byQ[q.id] || {}, q))}</span>
        </li>`).join("");
      const name  = s.user?.full_name || "Anonymous";
      const scope = scopeFromSubmission(s);
      const delBtn = isAdmin() ? `<button type="button" class="sp-btn sp-btn--danger sp-btn--sm" data-delete-sub="${SP.utils.escapeHtml(s.id)}">Delete</button>` : "";
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

    el.users.innerHTML = `<div class="sp-users__desktop">${tableHtml}</div><div class="sp-users__mobile">${cardsHtml}</div>`;

    if (isAdmin()) {
      el.users.querySelectorAll("[data-delete-sub]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-delete-sub");
          const s = lastUserRows.find((x) => x.id === id);
          const who = s?.user?.full_name || "this respondent";
          el.modalDsBody.textContent = `Delete the response from ${who}?`;
          pendingDeleteSubId = id;
          openModal(el.modalDs);
        });
      });
    }
  }

  // -------------------------------------------------------
  // CSV export
  // -------------------------------------------------------
  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }

  function downloadCsv(submissions, questions, filename) {
    try {
      const header = ["Submission ID","Respondent","Scope","Submitted At","Question","Question Type","Answer"];
      const lines = [header.map(csvEscape).join(",")];
      const qById = {}; questions.forEach((q) => { qById[q.id] = q; });
      for (const s of submissions) {
        const who   = s.user?.full_name || "Anonymous";
        const scope = scopeFromSubmission(s);
        const when  = SP.utils.formatDate(s.submitted_at);
        const answers = (s.answers || []).filter((a) => qById[a.question_id]);
        if (!answers.length) {
          lines.push([s.id, who, scope, when, "", "", ""].map(csvEscape).join(",")); continue;
        }
        for (const a of answers) {
          const q = qById[a.question_id];
          lines.push([s.id, who, scope, when, q?.text || "", q?.type || "", answerValue(a, q)].map(csvEscape).join(","));
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
    if (!selectedPollId) { SP.utils.toast("Select a poll first.", "error"); return; }
    if (!lastUserRows.length) { SP.utils.toast("No data to export yet.", "error"); return; }
    const scope = currentFilter === "all" ? "all" : currentFilter.slice(0, 8);
    const slug = selectedPoll?.slug || "poll";
    downloadCsv(lastUserRows, activeQuestions, `swift-poll-${slug}-${scope}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/^unauthorized$/i.test(msg) || /42501/.test(msg))
      return "Your admin session has expired. Please log in again.";
    if (/Supabase URL not configured|Supabase client library not loaded/i.test(msg))
      return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/row-level security|RLS/i.test(msg)) return "Database blocked the write. Re-run supabase-schema.sql.";
    if (/Invalid API key|JWT|401/i.test(msg)) return "Invalid Supabase anon key.";
    if (/function .* does not exist/i.test(msg)) return "Database is out of date. Re-run supabase-schema.sql.";
    if (/relation .* does not exist/i.test(msg)) return "Database tables missing. Run supabase-schema.sql.";
    if (/duplicate key/i.test(msg)) return "That slug is already used. Pick a different one.";
    if (/must have at least one active question/i.test(msg)) return msg;
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
