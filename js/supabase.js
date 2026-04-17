/**
 * Swift Poll - Supabase client + data-access layer.
 *
 * Supabase is the source of truth for poll content. Questions
 * and options are fetched from the DB (filtered by is_active
 * and deleted_at null), cached in memory, and invalidated after
 * every admin write.
 */

window.SP = window.SP || {};

SP.db = (function () {
  const cfg = window.SWIFT_POLL_CONFIG || {};
  let client = null;
  let pollCache = null;         // { id, slug, title, description }
  let questionsCache = null;    // ordered [{ id, text, order, options: [...] }]

  // Limits mirror the schema CHECK constraints
  const LIMITS = { QUESTION_TEXT_MAX: 150, OPTION_TEXT_MAX: 75, OPTION_COUNT: 4 };

  function init() {
    if (client) return client;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("Supabase client library not loaded");
    }
    if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT-REF")) {
      throw new Error("Supabase URL not configured - edit js/config.js");
    }
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });
    return client;
  }

  function invalidateCache() {
    pollCache = null;
    questionsCache = null;
  }

  // -------------------------------------------------------
  // Poll
  // -------------------------------------------------------
  async function getPoll() {
    if (pollCache) return pollCache;
    const supa = init();
    const { data, error } = await supa
      .from("polls")
      .select("id, slug, title, description")
      .eq("slug", cfg.POLL_SLUG)
      .single();
    if (error) throw error;
    pollCache = data;
    return data;
  }

  // -------------------------------------------------------
  // Active questions (single source of truth for rendering)
  // -------------------------------------------------------
  async function getActiveQuestions() {
    if (questionsCache) return questionsCache;
    const supa = init();
    const poll = await getPoll();

    const { data, error } = await supa
      .from("questions")
      .select(`
        id, question_text, display_order, is_active, deleted_at,
        question_options ( id, option_text, option_value, display_order, is_active, deleted_at )
      `)
      .eq("poll_id", poll.id)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("display_order", { ascending: true });
    if (error) throw error;

    questionsCache = (data || []).map((q) => ({
      id: q.id,
      text: q.question_text,
      order: q.display_order,
      options: (q.question_options || [])
        .filter((o) => o.is_active && !o.deleted_at)
        .sort((a, b) => a.display_order - b.display_order)
        .map((o) => ({
          id: o.id,
          text: o.option_text,
          value: o.option_value,
          order: o.display_order
        }))
    }));

    return questionsCache;
  }

  async function getNextQuestionOrder() {
    const supa = init();
    const poll = await getPoll();
    const { data, error } = await supa
      .from("questions")
      .select("display_order")
      .eq("poll_id", poll.id)
      .order("display_order", { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data && data[0] && data[0].display_order) || 0) + 1;
  }

  // -------------------------------------------------------
  // Admin: create / soft-delete questions
  // -------------------------------------------------------
  function validateQuestionPayload({ text, options }) {
    const errors = [];
    const cleanText = String(text == null ? "" : text).trim();
    if (!cleanText) errors.push("Question text is required.");
    else if (cleanText.length > LIMITS.QUESTION_TEXT_MAX) {
      errors.push(`Question must be ${LIMITS.QUESTION_TEXT_MAX} characters or fewer.`);
    }

    const raw = Array.isArray(options) ? options : [];
    const cleanOptions = raw.map((o) => String(o == null ? "" : o).trim());

    if (cleanOptions.length !== LIMITS.OPTION_COUNT) {
      errors.push(`Exactly ${LIMITS.OPTION_COUNT} options are required.`);
    }
    if (cleanOptions.some((t) => !t)) {
      errors.push("All 4 options are required - no blanks.");
    }
    if (cleanOptions.some((t) => t.length > LIMITS.OPTION_TEXT_MAX)) {
      errors.push(`Each option must be ${LIMITS.OPTION_TEXT_MAX} characters or fewer.`);
    }
    const lower = cleanOptions.map((t) => t.toLowerCase());
    if (new Set(lower).size < lower.length) {
      errors.push("Options must be different from each other.");
    }

    return { errors, cleanText, cleanOptions };
  }

  async function createQuestionWithOptions({ text, options }) {
    const { errors, cleanText, cleanOptions } = validateQuestionPayload({ text, options });
    if (errors.length) {
      const err = new Error(errors[0]);
      err.validation = errors;
      throw err;
    }

    const supa = init();
    const poll = await getPoll();
    const nextOrder = await getNextQuestionOrder();

    const { data: q, error: qErr } = await supa
      .from("questions")
      .insert({
        poll_id: poll.id,
        question_text: cleanText,
        question_type: "single_select",
        display_order: nextOrder,
        is_active: true
      })
      .select("id")
      .single();
    if (qErr) throw qErr;

    const optionRows = cleanOptions.map((t, i) => ({
      question_id: q.id,
      option_text: t,
      option_value: `opt_${i + 1}`,
      display_order: i + 1,
      is_active: true
    }));
    const { error: oErr } = await supa.from("question_options").insert(optionRows);
    if (oErr) {
      // Best-effort rollback so we do not leave an orphan question
      await supa.from("questions").delete().eq("id", q.id);
      throw oErr;
    }

    invalidateCache();
    return q.id;
  }

  /**
   * Soft delete: flips is_active to false and stamps deleted_at
   * on the question and all its options. Historical answers keep
   * their FKs and stay in the DB; they are filtered out at query
   * time because their parent question is no longer active.
   */
  async function softDeleteQuestion(questionId) {
    const supa = init();
    const now = new Date().toISOString();

    const { error: oErr } = await supa
      .from("question_options")
      .update({ is_active: false, deleted_at: now })
      .eq("question_id", questionId);
    if (oErr) throw oErr;

    const { error: qErr } = await supa
      .from("questions")
      .update({ is_active: false, deleted_at: now, updated_at: now })
      .eq("id", questionId);
    if (qErr) throw qErr;

    invalidateCache();
  }

  // -------------------------------------------------------
  // Users + submissions
  // -------------------------------------------------------
  async function createUser({ fullName, sessionId }) {
    const supa = init();
    const payload = {
      full_name: fullName,
      contact_value: null,
      session_id: sessionId || null
    };
    const { data, error } = await supa
      .from("users")
      .insert(payload)
      .select("id, full_name, session_id, created_at")
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * @param {Object} args
   * @param {string} args.userId
   * @param {string} args.assignedUser - one of user_1 .. user_6
   * @param {Array<{questionId:string, optionId:string, optionText:string}>} args.answers
   */
  async function submitPoll({ userId, assignedUser, answers }) {
    if (!assignedUser) throw new Error("assigned_user is required");
    const supa = init();
    const poll = await getPoll();

    const { data: submission, error: subErr } = await supa
      .from("submissions")
      .insert({
        poll_id: poll.id,
        user_id: userId,
        assigned_user: assignedUser,
        status: "submitted"
      })
      .select("id, submitted_at")
      .single();
    if (subErr) throw subErr;

    const answerRows = answers.map((a) => ({
      submission_id: submission.id,
      question_id: a.questionId,
      selected_option_id: a.optionId,
      selected_option_text: a.optionText
    }));
    const { error: ansErr } = await supa.from("answers").insert(answerRows);
    if (ansErr) throw ansErr;

    return submission;
  }

  // -------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------
  // `filter.assignedUser` may be undefined / "all" (no filter)
  // or one of user_1 .. user_6 (scope to that user).
  function resolveAssignedUserFilter(filter) {
    const v = filter && filter.assignedUser;
    if (!v || v === "all") return null;
    return v;
  }

  async function getAggregatedResults(filter) {
    const supa = init();
    const poll = await getPoll();
    const questions = await getActiveQuestions();
    const assignedUser = resolveAssignedUserFilter(filter);

    const scaffold = questions.map((q) => ({
      id: q.id, text: q.text, order: q.order,
      options: q.options.map((o) => ({ id: o.id, text: o.text, value: o.value, order: o.order, count: 0 }))
    }));

    const activeOptionIds = new Set();
    for (const q of scaffold) for (const o of q.options) activeOptionIds.add(o.id);

    let query = supa
      .from("answers")
      .select("selected_option_id, question_id, submission:submissions!inner(poll_id, assigned_user)")
      .eq("submission.poll_id", poll.id);
    if (assignedUser) query = query.eq("submission.assigned_user", assignedUser);

    const { data: rows, error } = await query;
    if (error) throw error;

    const byOption = new Map();
    for (const r of rows || []) {
      if (!activeOptionIds.has(r.selected_option_id)) continue;
      byOption.set(r.selected_option_id, (byOption.get(r.selected_option_id) || 0) + 1);
    }

    for (const q of scaffold) {
      for (const o of q.options) o.count = byOption.get(o.id) || 0;
      q.total = q.options.reduce((s, o) => s + o.count, 0);
    }
    return { poll, questions: scaffold };
  }

  async function getUserResponses(filter) {
    const supa = init();
    const poll = await getPoll();
    const assignedUser = resolveAssignedUserFilter(filter);

    let query = supa
      .from("submissions")
      .select(`
        id,
        submitted_at,
        status,
        assigned_user,
        user:users ( id, full_name, contact_value, session_id ),
        answers (
          question_id,
          selected_option_text,
          question:questions ( id, question_text, display_order, is_active, deleted_at )
        )
      `)
      .eq("poll_id", poll.id)
      .order("submitted_at", { ascending: false });
    if (assignedUser) query = query.eq("assigned_user", assignedUser);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getTotalSubmissions(filter) {
    const supa = init();
    const poll = await getPoll();
    const assignedUser = resolveAssignedUserFilter(filter);

    let query = supa
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("poll_id", poll.id);
    if (assignedUser) query = query.eq("assigned_user", assignedUser);

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  return {
    init, invalidateCache, LIMITS,
    getPoll, getActiveQuestions, getNextQuestionOrder,
    createQuestionWithOptions, softDeleteQuestion,
    createUser, submitPoll,
    getAggregatedResults, getUserResponses, getTotalSubmissions
  };
})();
