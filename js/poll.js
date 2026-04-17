/**
 * Swift Poll - poll flow controller.
 *
 * Questions are fetched live from Supabase, not from config.
 * Each question carries its own option set (DB uuid + text). The
 * user's answer is keyed by question id and points at the chosen
 * option id, which is what we ship at submit time.
 *
 * Screens:
 *   1. Identity - name only
 *   2. Question - one per screen, DB-driven
 *   3. Success  - after Supabase write succeeds
 *   Empty     - when no active questions exist yet
 */
(function () {
  const state = {
    questions: [],       // [{ id, text, order, options: [...] }]
    user: null,          // { id, fullName }
    answers: {},         // { [questionId]: { optionId, optionText } }
    currentIndex: 0,
    submitting: false,
    submitted: false
  };

  let el = {};

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();

    el = {
      identity:      document.querySelector("[data-screen='identity']"),
      question:      document.querySelector("[data-screen='question']"),
      success:       document.querySelector("[data-screen='success']"),
      empty:         document.querySelector("[data-screen='empty']"),

      identityForm:  document.querySelector("[data-identity-form]"),
      fullName:      document.querySelector("[name='fullName']"),
      identityError: document.querySelector("[data-identity-error]"),

      progressBar:   document.querySelector("[data-progress-bar]"),
      progressLabel: document.querySelector("[data-progress-label]"),
      qText:         document.querySelector("[data-question-text]"),
      qOptions:      document.querySelector("[data-question-options]"),

      backBtn:       document.querySelector("[data-nav-back]"),
      nextBtn:       document.querySelector("[data-nav-next]"),
      submitError:   document.querySelector("[data-submit-error]")
    };

    try {
      state.questions = await SP.db.getActiveQuestions();
    } catch (err) {
      console.error(err);
      el.identityError && (el.identityError.textContent = friendlyError(err, "Could not load the poll."));
      showIdentity();
      return;
    }

    if (!state.questions.length) {
      showEmpty();
      return;
    }

    restoreDraft();
    wireIdentity();
    wireNavigation();

    if (state.user) showQuestion();
    else showIdentity();
  });

  // -------------------------------------------------------
  // Screen switching
  // -------------------------------------------------------
  function hideAll() {
    [el.identity, el.question, el.success, el.empty].forEach((n) => n && n.classList.add("is-hidden"));
  }
  function showIdentity() {
    hideAll();
    el.identity.classList.remove("is-hidden");
    setTimeout(() => el.fullName && el.fullName.focus(), 50);
  }
  function showQuestion() {
    hideAll();
    el.question.classList.remove("is-hidden");
    renderQuestion();
  }
  function showSuccess() {
    hideAll();
    el.success.classList.remove("is-hidden");
  }
  function showEmpty() {
    hideAll();
    if (el.empty) el.empty.classList.remove("is-hidden");
  }

  // -------------------------------------------------------
  // Draft persistence - per-poll-version so stale drafts get
  // discarded if the admin changes the question set.
  // -------------------------------------------------------
  function draftKey() {
    return "q:" + state.questions.map((q) => q.id).join("|");
  }
  function saveDraft() {
    SP.utils.saveDraft({
      key: draftKey(),
      answers: state.answers,
      currentIndex: state.currentIndex
    });
  }
  function restoreDraft() {
    const draft = SP.utils.loadDraft();
    const user  = SP.utils.loadUser();
    if (user && user.id) state.user = user;
    if (draft && draft.key === draftKey() && draft.answers) {
      state.answers = draft.answers;
      state.currentIndex = Math.min(draft.currentIndex || 0, state.questions.length - 1);
    } else if (draft) {
      SP.utils.clearDraft();
    }
  }

  // -------------------------------------------------------
  // Identity
  // -------------------------------------------------------
  function wireIdentity() {
    if (!el.identityForm) return;
    el.identityForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.identityError.textContent = "";
      const fullName = (el.fullName.value || "").trim();
      if (!fullName) {
        el.identityError.textContent = "Please enter your full name.";
        el.fullName.focus();
        return;
      }

      const submitBtn = el.identityForm.querySelector("button[type='submit']");
      submitBtn.disabled = true;
      submitBtn.textContent = "Starting...";
      try {
        const sessionId = SP.utils.getSessionId();
        const user = await SP.db.createUser({ fullName, sessionId });
        state.user = { id: user.id, fullName: user.full_name };
        SP.utils.saveUser(state.user);
        submitBtn.disabled = false;
        submitBtn.textContent = "Start Poll";
        showQuestion();
      } catch (err) {
        console.error(err);
        el.identityError.textContent = friendlyError(err, "Could not start the poll. Please try again.");
        submitBtn.disabled = false;
        submitBtn.textContent = "Start Poll";
      }
    });
  }

  // -------------------------------------------------------
  // Question rendering
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

    el.qOptions.innerHTML = "";
    const selected = state.answers[q.id]?.optionId;

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
        document.querySelectorAll(".sp-option").forEach((n) => n.classList.remove("sp-option--selected"));
        wrap.classList.add("sp-option--selected");
        el.nextBtn.disabled = false;
      });
      el.qOptions.appendChild(wrap);
    });

    el.backBtn.disabled = idx === 0;
    el.nextBtn.disabled = !state.answers[q.id] || state.submitting;
    el.nextBtn.textContent = isLast ? (state.submitting ? "Submitting..." : "Submit") : "Next";
    el.submitError.textContent = "";
  }

  function wireNavigation() {
    el.backBtn.addEventListener("click", () => {
      if (state.currentIndex > 0) {
        state.currentIndex -= 1;
        saveDraft();
        renderQuestion();
      }
    });
    el.nextBtn.addEventListener("click", async () => {
      const idx = state.currentIndex;
      const q = state.questions[idx];
      if (!state.answers[q.id]) return;

      if (idx < state.questions.length - 1) {
        state.currentIndex += 1;
        saveDraft();
        renderQuestion();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        await submitPoll();
      }
    });
  }

  // -------------------------------------------------------
  // Submit
  // -------------------------------------------------------
  async function submitPoll() {
    if (state.submitting || state.submitted) return;
    state.submitting = true;
    el.nextBtn.disabled = true;
    el.backBtn.disabled = true;
    el.nextBtn.textContent = "Submitting...";
    el.submitError.textContent = "";

    try {
      const payload = state.questions.map((q) => {
        const a = state.answers[q.id];
        return { questionId: q.id, optionId: a.optionId, optionText: a.optionText };
      });
      await SP.db.submitPoll({ userId: state.user.id, answers: payload });

      state.submitted = true;
      SP.utils.clearDraft();
      showSuccess();
      el.progressBar.style.width = "100%";
      SP.utils.toast("Responses saved. Thank you!", "ok");
    } catch (err) {
      console.error(err);
      state.submitting = false;
      el.nextBtn.disabled = false;
      el.backBtn.disabled = false;
      el.nextBtn.textContent = "Submit";
      el.submitError.textContent = friendlyError(err, "Could not submit right now. Please try again.");
    }
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
