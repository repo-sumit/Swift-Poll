/**
 * Swift Poll - Supabase client + data-access layer.
 *
 * Supabase is the source of truth for poll content and dashboard
 * accounts. Passwords are never read by the client: all login /
 * user-management calls go through security-definer RPCs.
 */

window.SP = window.SP || {};

SP.db = (function () {
  const cfg = window.SWIFT_POLL_CONFIG || {};
  let client = null;
  let pollCache = null;
  let questionsCache = null;

  const LIMITS = {
    QUESTION_TEXT_MAX: 150,
    OPTION_TEXT_MAX:   75,
    TEXT_ANSWER_MAX:   200,
    OPTION_MIN: 2,
    OPTION_MAX: 5
  };

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

  function invalidateCache() { pollCache = null; questionsCache = null; }

  // -------------------------------------------------------
  // Poll + questions (DB is source of truth)
  // -------------------------------------------------------
  async function getPoll() {
    if (pollCache) return pollCache;
    const supa = init();
    const { data, error } = await supa.from("polls")
      .select("id, slug, title, description")
      .eq("slug", cfg.POLL_SLUG).single();
    if (error) throw error;
    pollCache = data;
    return data;
  }

  async function getActiveQuestions() {
    if (questionsCache) return questionsCache;
    const supa = init();
    const poll = await getPoll();

    const { data, error } = await supa.from("questions")
      .select(`
        id, question_text, question_type, display_order, is_active, is_required, deleted_at,
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
      type: q.question_type || "single_select",
      required: !!q.is_required,
      order: q.display_order,
      options: (q.question_options || [])
        .filter((o) => o.is_active && !o.deleted_at)
        .sort((a, b) => a.display_order - b.display_order)
        .map((o) => ({ id: o.id, text: o.option_text, value: o.option_value, order: o.display_order }))
    }));
    return questionsCache;
  }

  async function getNextQuestionOrder() {
    const supa = init();
    const poll = await getPoll();
    const { data, error } = await supa.from("questions")
      .select("display_order")
      .eq("poll_id", poll.id)
      .order("display_order", { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data && data[0] && data[0].display_order) || 0) + 1;
  }

  // -------------------------------------------------------
  // Question authoring (admin)
  // -------------------------------------------------------
  function validateQuestionPayload({ text, type, required, options }) {
    const errors = [];
    const cleanText = String(text == null ? "" : text).trim();
    if (!cleanText) errors.push("Question text is required.");
    else if (cleanText.length > LIMITS.QUESTION_TEXT_MAX) {
      errors.push(`Question must be ${LIMITS.QUESTION_TEXT_MAX} characters or fewer.`);
    }

    const questionType = (type === "text_input") ? "text_input" : "single_select";
    let cleanOptions = [];

    if (questionType === "single_select") {
      const raw = Array.isArray(options) ? options : [];
      cleanOptions = raw.map((o) => String(o == null ? "" : o).trim()).filter((t) => t.length > 0);

      if (cleanOptions.length < LIMITS.OPTION_MIN) {
        errors.push(`MCQ needs at least ${LIMITS.OPTION_MIN} non-blank options.`);
      }
      if (cleanOptions.length > LIMITS.OPTION_MAX) {
        errors.push(`MCQ allows at most ${LIMITS.OPTION_MAX} options.`);
      }
      if (cleanOptions.some((t) => t.length > LIMITS.OPTION_TEXT_MAX)) {
        errors.push(`Each option must be ${LIMITS.OPTION_TEXT_MAX} characters or fewer.`);
      }
      const lower = cleanOptions.map((t) => t.toLowerCase());
      if (new Set(lower).size < lower.length) errors.push("Options must be different from each other.");
    }

    return { errors, cleanText, cleanOptions, questionType, required: !!required };
  }

  async function createQuestionWithOptions({ text, type, required, options }) {
    const v = validateQuestionPayload({ text, type, required, options });
    if (v.errors.length) {
      const err = new Error(v.errors[0]); err.validation = v.errors; throw err;
    }
    const supa = init();
    const poll = await getPoll();
    const nextOrder = await getNextQuestionOrder();

    const { data: q, error: qErr } = await supa.from("questions").insert({
      poll_id: poll.id,
      question_text: v.cleanText,
      question_type: v.questionType,
      display_order: nextOrder,
      is_active: true,
      is_required: v.required
    }).select("id").single();
    if (qErr) throw qErr;

    if (v.questionType === "single_select") {
      const optionRows = v.cleanOptions.map((t, i) => ({
        question_id: q.id,
        option_text: t,
        option_value: `opt_${i + 1}`,
        display_order: i + 1,
        is_active: true
      }));
      const { error: oErr } = await supa.from("question_options").insert(optionRows);
      if (oErr) {
        await supa.from("questions").delete().eq("id", q.id);
        throw oErr;
      }
    }

    invalidateCache();
    return q.id;
  }

  async function softDeleteQuestion(questionId) {
    const supa = init();
    const now = new Date().toISOString();
    const { error: oErr } = await supa.from("question_options")
      .update({ is_active: false, deleted_at: now })
      .eq("question_id", questionId);
    if (oErr) throw oErr;
    const { error: qErr } = await supa.from("questions")
      .update({ is_active: false, deleted_at: now, updated_at: now })
      .eq("id", questionId);
    if (qErr) throw qErr;
    invalidateCache();
  }

  // -------------------------------------------------------
  // Dashboard accounts (via RPCs so hashes never leave the DB)
  // -------------------------------------------------------
  async function loginDashboardUser({ displayName, password }) {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_login", {
      p_display_name: displayName,
      p_password: password
    });
    if (error) throw error;
    if (!data || !data.length) return null;
    return data[0];
  }

  async function listDashboardUsers() {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_list_users");
    if (error) throw error;
    return data || [];
  }

  async function getPollUserOptions() {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_active_user_accounts");
    if (error) throw error;
    return data || [];
  }

  async function createDashboardUser({ displayName, password, role }) {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_create_user", {
      p_display_name: displayName, p_password: password, p_role: role || "user"
    });
    if (error) throw error;
    return data;
  }

  async function renameDashboardUser(id, newName) {
    const supa = init();
    const { error } = await supa.rpc("dashboard_rename_user", { p_id: id, p_new_name: newName });
    if (error) throw error;
  }

  async function changeDashboardPassword(id, newPassword) {
    const supa = init();
    const { error } = await supa.rpc("dashboard_change_password", {
      p_id: id, p_new_password: newPassword
    });
    if (error) throw error;
  }

  async function deleteDashboardUser(id) {
    const supa = init();
    const { error } = await supa.rpc("dashboard_delete_user", { p_id: id });
    if (error) throw error;
  }

  async function resetPollData() {
    const supa = init();
    const { error } = await supa.rpc("dashboard_reset_data");
    if (error) throw error;
    invalidateCache();
  }

  // -------------------------------------------------------
  // Respondent / submission
  // -------------------------------------------------------
  async function createUser({ fullName, sessionId }) {
    const supa = init();
    const { data, error } = await supa.from("users")
      .insert({ full_name: fullName, contact_value: null, session_id: sessionId || null })
      .select("id, full_name, session_id, created_at").single();
    if (error) throw error;
    return data;
  }

  /**
   * answers: each item is either
   *   { questionId, optionId, optionText } for MCQ
   *   { questionId, textAnswer }           for text_input
   *   { questionId, skipped: true }        for optional skipped
   */
  async function submitPoll({ userId, assignedUserId, answers }) {
    if (!assignedUserId) throw new Error("assigned_user_id is required");
    const supa = init();
    const poll = await getPoll();

    const { data: submission, error: subErr } = await supa.from("submissions").insert({
      poll_id: poll.id,
      user_id: userId,
      assigned_user_id: assignedUserId,
      status: "submitted"
    }).select("id, submitted_at").single();
    if (subErr) throw subErr;

    const answerRows = answers
      .filter((a) => !a.skipped)
      .map((a) => ({
        submission_id: submission.id,
        question_id: a.questionId,
        selected_option_id: a.optionId || null,
        selected_option_text: a.optionText || null,
        text_answer: a.textAnswer != null ? a.textAnswer : null
      }));

    if (answerRows.length) {
      const { error: ansErr } = await supa.from("answers").insert(answerRows);
      if (ansErr) throw ansErr;
    }
    return submission;
  }

  async function deleteSubmission(submissionId) {
    const supa = init();
    // ON DELETE CASCADE handles answers
    const { error } = await supa.from("submissions").delete().eq("id", submissionId);
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Dashboard reads
  // -------------------------------------------------------
  function resolveAssignedUserFilter(filter) {
    const v = filter && filter.assignedUserId;
    if (!v || v === "all") return null;
    return v;
  }

  async function getAggregatedResults(filter) {
    const supa = init();
    const poll = await getPoll();
    const questions = await getActiveQuestions();
    const assignedUserId = resolveAssignedUserFilter(filter);

    const scaffold = questions.map((q) => ({
      id: q.id, text: q.text, type: q.type, required: q.required, order: q.order,
      options: q.options.map((o) => ({ id: o.id, text: o.text, value: o.value, order: o.order, count: 0 })),
      textCount: 0
    }));
    const activeOptionIds = new Set();
    const mcqQuestionIds = new Set();
    const textQuestionIds = new Set();
    for (const q of scaffold) {
      if (q.type === "single_select") mcqQuestionIds.add(q.id);
      else if (q.type === "text_input") textQuestionIds.add(q.id);
      for (const o of q.options) activeOptionIds.add(o.id);
    }

    let query = supa.from("answers")
      .select("selected_option_id, question_id, text_answer, submission:submissions!inner(poll_id, assigned_user_id)")
      .eq("submission.poll_id", poll.id);
    if (assignedUserId) query = query.eq("submission.assigned_user_id", assignedUserId);

    const { data: rows, error } = await query;
    if (error) throw error;

    const byOption = new Map();
    const textCounts = new Map();
    for (const r of rows || []) {
      if (r.selected_option_id && activeOptionIds.has(r.selected_option_id)) {
        byOption.set(r.selected_option_id, (byOption.get(r.selected_option_id) || 0) + 1);
      }
      if (r.text_answer && textQuestionIds.has(r.question_id)) {
        textCounts.set(r.question_id, (textCounts.get(r.question_id) || 0) + 1);
      }
    }

    for (const q of scaffold) {
      if (q.type === "single_select") {
        for (const o of q.options) o.count = byOption.get(o.id) || 0;
        q.total = q.options.reduce((s, o) => s + o.count, 0);
      } else {
        q.total = textCounts.get(q.id) || 0;
      }
    }
    return { poll, questions: scaffold };
  }

  async function getUserResponses(filter) {
    const supa = init();
    const poll = await getPoll();
    const assignedUserId = resolveAssignedUserFilter(filter);

    let query = supa.from("submissions").select(`
      id, submitted_at, status, assigned_user_id,
      user:users ( id, full_name, session_id ),
      assigned:assigned_user_id ( id, display_name ),
      answers (
        question_id, selected_option_text, text_answer,
        question:questions ( id, question_text, question_type, display_order, is_active, deleted_at )
      )
    `)
    .eq("poll_id", poll.id)
    .order("submitted_at", { ascending: false });
    if (assignedUserId) query = query.eq("assigned_user_id", assignedUserId);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getTotalSubmissions(filter) {
    const supa = init();
    const poll = await getPoll();
    const assignedUserId = resolveAssignedUserFilter(filter);

    let query = supa.from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("poll_id", poll.id);
    if (assignedUserId) query = query.eq("assigned_user_id", assignedUserId);

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  return {
    init, invalidateCache, LIMITS,
    // poll content
    getPoll, getActiveQuestions, getNextQuestionOrder,
    createQuestionWithOptions, softDeleteQuestion,
    // dashboard accounts
    loginDashboardUser, listDashboardUsers, getPollUserOptions,
    createDashboardUser, renameDashboardUser, changeDashboardPassword, deleteDashboardUser,
    // submissions
    createUser, submitPoll, deleteSubmission, resetPollData,
    // dashboard reads
    getAggregatedResults, getUserResponses, getTotalSubmissions
  };
})();
