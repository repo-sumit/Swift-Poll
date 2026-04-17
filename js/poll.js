/**
 * Swift Poll - poll flow controller.
 *
 * Screens:
 *   1. Identity  - collect full name + optional contact
 *   2. Question  - one per screen, driven from config.js
 *   3. Success   - after Supabase write succeeds
 *
 * Answers live in memory (and in localStorage as a draft) until
 * the final submit, which performs the Supabase writes in one go.
 */
(function () {
  const CFG = window.SWIFT_POLL_CONFIG || {};
  const QUESTIONS = [...(CFG.QUESTIONS || [])].sort((a, b) => a.order - b.order);
  const OPTIONS = CFG.OPTIONS || [];

  const state = {
    user: null,           // { id, fullName, contact }
    answers: {},          // { [question.id]: option.value }
    currentIndex: 0,      // index into QUESTIONS
    submitting: false,
    submitted: false
  };

  // -------- DOM refs (resolved after DOMContentLoaded)
  let el = {};

  document.addEventListener("DOMContentLoaded", () => {
    SP.utils.setHeaderBrand();

    el = {
      identity:      document.querySelector("[data-screen='identity']"),
      question:      document.querySelector("[data-screen='question']"),
      success:       document.querySelector("[data-screen='success']"),

      identityForm:  document.querySelector("[data-identity-form]"),
      fullName:      document.querySelector("[name='fullName']"),
      contact:       document.querySelector("[name='contact']"),
      identityError: document.querySelector("[data-identity-error]"),

      progressBar:   document.querySelector("[data-progress-bar]"),
      progressLabel: document.querySelector("[data-progress-label]"),
      qText:         document.querySelector("[data-question-text]"),
      qOptions:      document.querySelector("[data-question-options]"),

      backBtn:       document.querySelector("[data-nav-back]"),
      nextBtn:       document.querySelector("[data-nav-next]"),
      submitError:   document.querySelector("[data-submit-error]"),

      goDashboard:   document.querySelector("[data-go-dashboard]"),
      goHome:        document.querySelector("[data-go-home]")
    };

    restoreDraft();
    wireIdentity();
    wireNavigation();

    if (state.user) showQuestion();
    else showIdentity();
  });

  // -------------------------------------------------------
  // Draft persistence - survives accidental refresh
  // -------------------------------------------------------
  function saveDraft() {
    SP.utils.saveDraft({
      answers: state.answers,
      currentIndex: state.currentIndex
    });
  }
  function restoreDraft() {
    const draft = SP.utils.loadDraft();
    const user  = SP.utils.loadUser();
    if (user && user.id) state.user = user;
    if (draft && draft.answers) {
      state.answers = draft.answers;
      state.currentIndex = Math.min(draft.currentIndex || 0, QUESTIONS.length - 1);
    }
  }

  // -------------------------------------------------------
  // Screen: identity
  // -------------------------------------------------------
  function showIdentity() {
    el.identity.classList.remove("is-hidden");
    el.question.classList.add("is-hidden");
    el.success.classList.add("is-hidden");
    setTimeout(() => el.fullName && el.fullName.focus(), 50);
  }

  function wireIdentity() {
    if (!el.identityForm) return;
    el.identityForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      el.identityError.textContent = "";
      const fullName = (el.fullName.value || "").trim();
      const contact  = (el.contact.value || "").trim();
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
        const user = await SP.db.createUser({ fullName, contact, sessionId });
        state.user = {
          id: user.id,
          fullName: user.full_name,
          contact: user.contact_value
        };
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
  // Screen: question
  // -------------------------------------------------------
  function showQuestion() {
    el.identity.classList.add("is-hidden");
    el.question.classList.remove("is-hidden");
    el.success.classList.add("is-hidden");
    renderQuestion();
  }

  function renderQuestion() {
    const idx = state.currentIndex;
    const total = QUESTIONS.length;
    const q = QUESTIONS[idx];
    const isLast = idx === total - 1;

    const pct = Math.round(((idx) / total) * 100);
    el.progressBar.style.width = pct + "%";
    el.progressBar.setAttribute("aria-valuenow", String(pct));
    el.progressLabel.textContent = `Question ${idx + 1} of ${total}`;

    el.qText.textContent = q.text;

    // Render options
    el.qOptions.innerHTML = "";
    const selected = state.answers[q.id];
    OPTIONS.forEach((opt, i) => {
      const id = `opt-${q.id}-${opt.value}`;
      const wrap = document.createElement("label");
      wrap.className = "sp-option" + (selected === opt.value ? " sp-option--selected" : "");
      wrap.setAttribute("for", id);
      wrap.innerHTML = `
        <input type="radio" id="${id}" name="answer" value="${SP.utils.escapeHtml(opt.value)}"
               ${selected === opt.value ? "checked" : ""} />
        <span class="sp-option__radio" aria-hidden="true"></span>
        <span class="sp-option__text">${SP.utils.escapeHtml(opt.text)}</span>
      `;
      wrap.querySelector("input").addEventListener("change", (e) => {
        state.answers[q.id] = e.target.value;
        saveDraft();
        document.querySelectorAll(".sp-option").forEach((n) => n.classList.remove("sp-option--selected"));
        wrap.classList.add("sp-option--selected");
        el.nextBtn.disabled = false;
      });
      el.qOptions.appendChild(wrap);
    });

    // Buttons
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
      const q = QUESTIONS[idx];
      if (!state.answers[q.id]) return;

      if (idx < QUESTIONS.length - 1) {
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
  // Final submit
  // -------------------------------------------------------
  async function submitPoll() {
    if (state.submitting || state.submitted) return;
    state.submitting = true;
    el.nextBtn.disabled = true;
    el.backBtn.disabled = true;
    el.nextBtn.textContent = "Submitting...";
    el.submitError.textContent = "";

    try {
      const payload = QUESTIONS.map((q) => ({
        questionText: q.text,
        optionValue:  state.answers[q.id]
      }));
      await SP.db.submitPoll({ userId: state.user.id, answers: payload });

      state.submitted = true;
      SP.utils.clearDraft();

      el.question.classList.add("is-hidden");
      el.success.classList.remove("is-hidden");

      // Full progress
      el.progressBar.style.width = "100%";
      SP.utils.toast("Responses saved. Thank you!", "ok");
    } catch (err) {
      console.error(err);
      state.submitting = false;
      el.nextBtn.disabled = false;
      el.backBtn.disabled = false;
      el.nextBtn.textContent = "Submit";
      el.submitError.textContent = friendlyError(err, "Could not submit right now. Please check your connection and try again.");
    }
  }

  // -------------------------------------------------------
  // Error helper
  // -------------------------------------------------------
  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/not configured/i.test(msg)) return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/fetch|network|failed/i.test(msg)) return "Network issue. Please try again in a moment.";
    if (/not found/i.test(msg)) return "Poll data missing in Supabase. Re-run supabase-schema.sql.";
    return fallback;
  }
})();
