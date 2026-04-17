/**
 * Swift Poll - poll flow controller.
 *
 * Questions come from Supabase and can be either:
 *   - single_select (MCQ 2-5 options)
 *   - text_input   (free text, max 200 chars)
 * Each question has a required/optional flag. The respondent
 * dropdown is populated from active dashboard_users with role='user'.
 */
(function () {
  const CFG = window.SWIFT_POLL_CONFIG || {};
  const TEXT_MAX = (SP.db && SP.db.LIMITS && SP.db.LIMITS.TEXT_ANSWER_MAX) || 200;

  const state = {
    questions: [],    // [{ id, text, type, required, options }]
    user: null,       // { id, fullName, assignedUserId, assignedUserLabel }
    answers: {},      // { [qId]: MCQ -> {optionId, optionText} | TEXT -> {textAnswer} }
    currentIndex: 0,
    submitting: false,
    submitted: false
  };

  let el = {};
  let pollUsers = [];  // [{id, display_name}]

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();

    el = {
      identity:      document.querySelector("[data-screen='identity']"),
      question:      document.querySelector("[data-screen='question']"),
      success:       document.querySelector("[data-screen='success']"),
      empty:         document.querySelector("[data-screen='empty']"),

      identityForm:  document.querySelector("[data-identity-form]"),
      fullName:      document.querySelector("[name='fullName']"),
      assignedUser:  document.querySelector("[data-assigned-user-select]"),
      identityError: document.querySelector("[data-identity-error]"),

      progressBar:   document.querySelector("[data-progress-bar]"),
      progressLabel: document.querySelector("[data-progress-label]"),
      qText:         document.querySelector("[data-question-text]"),
      qRequired:     document.querySelector("[data-question-required]"),
      qBody:         document.querySelector("[data-question-body]"),

      backBtn:       document.querySelector("[data-nav-back]"),
      skipBtn:       document.querySelector("[data-nav-skip]"),
      nextBtn:       document.querySelector("[data-nav-next]")
    };

    try {
      const [questions, users] = await Promise.all([
        SP.db.getActiveQuestions(),
        SP.db.getPollUserOptions()
      ]);
      state.questions = questions;
      pollUsers = users;
    } catch (err) {
      console.error(err);
      el.identityError && (el.identityError.textContent = friendlyError(err, "Could not load the poll."));
      showIdentity();
      return;
    }

    if (!state.questions.length) { showEmpty(); return; }

    populateAssignedUserOptions();
    // Every session starts at the identity screen. We deliberately
    // do not auto-resume from a saved user - entering name + user
    // is the consistent front door for everyone, every time.
    SP.utils.clearDraft();
    try { localStorage.removeItem(SP.utils.STORAGE_KEYS.USER); } catch (_) {}
    state.user = null;
    state.answers = {};
    state.currentIndex = 0;

    wireIdentity();
    wireNavigation();
    showIdentity();
  });

  // -------------------------------------------------------
  // Screens
  // -------------------------------------------------------
  function hideAll() {
    [el.identity, el.question, el.success, el.empty].forEach((n) => n && n.classList.add("is-hidden"));
  }
  function showIdentity() { hideAll(); el.identity.classList.remove("is-hidden"); setTimeout(() => el.fullName && el.fullName.focus(), 50); }
  function showQuestion() {
    // Defensive: never let the question screen render without a
    // confirmed name + user. Any stray code path falls back to identity.
    if (!state.user || !state.user.assignedUserId || !state.user.fullName) {
      showIdentity();
      return;
    }
    hideAll(); el.question.classList.remove("is-hidden"); renderQuestion();
  }
  function showSuccess()  { hideAll(); el.success.classList.remove("is-hidden"); }
  function showEmpty()    { hideAll(); el.empty && el.empty.classList.remove("is-hidden"); }

  // -------------------------------------------------------
  // Draft (within-session only - saves progress across the
  // question screens but is cleared at the start of every visit).
  // -------------------------------------------------------
  function draftKey() { return "q:" + state.questions.map((q) => q.id).join("|"); }
  function saveDraft() {
    SP.utils.saveDraft({ key: draftKey(), answers: state.answers, currentIndex: state.currentIndex });
  }

  // -------------------------------------------------------
  // Identity
  // -------------------------------------------------------
  function populateAssignedUserOptions() {
    if (!el.assignedUser) return;
    for (const u of pollUsers) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.display_name;
      el.assignedUser.appendChild(opt);
    }
  }

  function wireIdentity() {
    if (!el.identityForm) return;
    el.identityForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.identityError.textContent = "";
      const fullName = (el.fullName.value || "").trim();
      const chosenId = (el.assignedUser && el.assignedUser.value) || "";
      const chosenLabel = (el.assignedUser && el.assignedUser.selectedOptions[0]?.textContent) || "";

      if (!fullName) { el.identityError.textContent = "Please enter your full name."; el.fullName.focus(); return; }
      if (!chosenId) { el.identityError.textContent = "Please select a user."; el.assignedUser.focus(); return; }

      const submitBtn = el.identityForm.querySelector("button[type='submit']");
      submitBtn.disabled = true; submitBtn.textContent = "Starting...";
      try {
        const sessionId = SP.utils.getSessionId();
        const user = await SP.db.createUser({ fullName, sessionId });
        state.user = {
          id: user.id, fullName: user.full_name,
          assignedUserId: chosenId, assignedUserLabel: chosenLabel
        };
        SP.utils.saveUser(state.user);
        submitBtn.disabled = false; submitBtn.textContent = "Start Poll";
        showQuestion();
      } catch (err) {
        console.error(err);
        el.identityError.textContent = friendlyError(err, "Could not start the poll. Please try again.");
        submitBtn.disabled = false; submitBtn.textContent = "Start Poll";
      }
    });
  }

  // -------------------------------------------------------
  // Question rendering (MCQ or text)
  // -------------------------------------------------------
  function renderQuestion() {
    const idx = state.currentIndex;
    const total = state.questions.length;
    const q = state.questions[idx];
    const isLast = idx === total - 1;

    const pct = Math.round((idx / total) * 100);
    el.progressBar.style.width = pct + "%";
    el.progressBar.setAttribute("aria-valuenow", String(pct));
    el.progressLabel.textContent = `Question ${idx + 1} of ${total}`;

    el.qText.textContent = q.text;
    el.qRequired.textContent = q.required ? "Required" : "Optional";
    el.qRequired.classList.toggle("sp-q-required--yes", q.required);
    el.qRequired.classList.toggle("sp-q-required--no", !q.required);

    el.qBody.innerHTML = "";
    if (q.type === "text_input") renderTextAnswer(q);
    else                          renderMcqAnswer(q);

    el.backBtn.disabled = idx === 0;
    updateNavState();
    el.nextBtn.textContent = isLast ? (state.submitting ? "Submitting..." : "Submit") : "Next";
    // Skip is visible only for optional questions
    el.skipBtn.classList.toggle("is-hidden", q.required);
  }

  function renderMcqAnswer(q) {
    const selected = state.answers[q.id] && state.answers[q.id].optionId;
    q.options.forEach((opt) => {
      const id = `opt-${q.id}-${opt.id}`;
      const wrap = document.createElement("label");
      wrap.className = "sp-option" + (selected === opt.id ? " sp-option--selected" : "");
      wrap.setAttribute("for", id);
      wrap.innerHTML = `
        <input type="radio" id="${id}" name="answer" value="${SP.utils.escapeHtml(opt.id)}"
               ${selected === opt.id ? "checked" : ""} />
        <span class="sp-option__radio" aria-hidden="true"></span>
        <span class="sp-option__text">${SP.utils.escapeHtml(opt.text)}</span>
      `;
      wrap.querySelector("input").addEventListener("change", () => {
        state.answers[q.id] = { optionId: opt.id, optionText: opt.text };
        saveDraft();
        el.qBody.querySelectorAll(".sp-option").forEach((n) => n.classList.remove("sp-option--selected"));
        wrap.classList.add("sp-option--selected");
        updateNavState();
      });
      el.qBody.appendChild(wrap);
    });
  }

  function renderTextAnswer(q) {
    const cur = (state.answers[q.id] && state.answers[q.id].textAnswer) || "";
    const wrap = document.createElement("div");
    wrap.className = "sp-text-answer";
    wrap.innerHTML = `
      <textarea class="sp-input sp-input--area sp-text-answer__area"
                maxlength="${TEXT_MAX}" rows="4"
                placeholder="Type your answer..."
                aria-label="Your answer"></textarea>
      <div class="sp-text-answer__foot">
        <span class="sp-counter" data-text-counter>${cur.length} / ${TEXT_MAX}</span>
      </div>
    `;
    const ta = wrap.querySelector("textarea");
    const counter = wrap.querySelector("[data-text-counter]");
    ta.value = cur;
    ta.addEventListener("input", () => {
      const val = ta.value;
      counter.textContent = `${val.length} / ${TEXT_MAX}`;
      if (val.trim()) state.answers[q.id] = { textAnswer: val };
      else delete state.answers[q.id];
      saveDraft();
      updateNavState();
    });
    el.qBody.appendChild(wrap);
    setTimeout(() => ta.focus(), 60);
  }

  function updateNavState() {
    const q = state.questions[state.currentIndex];
    const ans = state.answers[q.id];
    const hasAnswer = !!ans && (
      (q.type === "single_select" && ans.optionId) ||
      (q.type === "text_input" && (ans.textAnswer || "").trim())
    );
    el.nextBtn.disabled = (q.required && !hasAnswer) || state.submitting;
  }

  function wireNavigation() {
    el.backBtn.addEventListener("click", () => {
      if (state.currentIndex > 0) {
        state.currentIndex -= 1; saveDraft(); renderQuestion();
      }
    });
    el.skipBtn.addEventListener("click", () => {
      const q = state.questions[state.currentIndex];
      if (q.required) return;
      delete state.answers[q.id];
      advanceOrSubmit();
    });
    el.nextBtn.addEventListener("click", () => advanceOrSubmit());
  }

  function advanceOrSubmit() {
    const idx = state.currentIndex;
    const q = state.questions[idx];
    const ans = state.answers[q.id];
    const hasAnswer = !!ans && (
      (q.type === "single_select" && ans.optionId) ||
      (q.type === "text_input" && (ans.textAnswer || "").trim())
    );
    if (q.required && !hasAnswer) return;

    if (idx < state.questions.length - 1) {
      state.currentIndex += 1; saveDraft(); renderQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      submitPoll();
    }
  }

  // -------------------------------------------------------
  // Submit
  // -------------------------------------------------------
  async function submitPoll() {
    if (state.submitting || state.submitted) return;
    state.submitting = true;
    el.nextBtn.disabled = true; el.backBtn.disabled = true;
    el.nextBtn.textContent = "Submitting...";

    try {
      const payload = state.questions.map((q) => {
        const a = state.answers[q.id];
        if (!a) return { questionId: q.id, skipped: true };
        if (q.type === "single_select") {
          return { questionId: q.id, optionId: a.optionId, optionText: a.optionText };
        }
        return { questionId: q.id, textAnswer: (a.textAnswer || "").trim() };
      });

      await SP.db.submitPoll({
        userId: state.user.id,
        assignedUserId: state.user.assignedUserId,
        answers: payload
      });

      state.submitted = true;
      SP.utils.clearDraft();
      showSuccess();
      el.progressBar.style.width = "100%";
      SP.utils.toast("Responses saved. Thank you!", "ok");
    } catch (err) {
      console.error(err);
      state.submitting = false;
      el.nextBtn.disabled = false; el.backBtn.disabled = false;
      el.nextBtn.textContent = "Submit";
      alert(friendlyError(err, "Could not submit right now."));
    }
  }

  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/Supabase URL not configured|Supabase client library not loaded/i.test(msg))
      return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again.";
    if (/function .* does not exist/i.test(msg)) return "Database is out of date. Re-run supabase-schema.sql.";
    if (/row-level security/i.test(msg)) return "Database blocked the write. Re-run supabase-schema.sql.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
