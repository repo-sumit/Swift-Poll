/**
 * Swift Poll - Supabase client + data-access layer (multi-poll).
 *
 * Everything that used to assume a single poll now takes a pollId
 * parameter. Accessible-poll lists go through RPCs that respect
 * dashboard_users / poll_user_access.
 */

window.SP = window.SP || {};

SP.db = (function () {
  const cfg = window.SWIFT_POLL_CONFIG || {};
  let client = null;
  const questionsCacheByPoll = new Map();   // pollId -> [{ id, text, type, required, order, options }]

  const LIMITS = {
    QUESTION_TEXT_MAX: 150,
    OPTION_TEXT_MAX:   75,
    TEXT_ANSWER_MAX:   200,
    OPTION_MIN: 2,
    OPTION_MAX: 5,
    POLL_TITLE_MAX:       120,
    POLL_SLUG_MAX:         60,
    POLL_DESCRIPTION_MAX: 400
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

  function invalidateCache(pollId) {
    if (pollId) questionsCacheByPoll.delete(pollId);
    else questionsCacheByPoll.clear();
  }

  // -------------------------------------------------------
  // Polls - CRUD + access lists
  // -------------------------------------------------------
  async function listAllPolls() {
    const supa = init();
    const { data, error } = await supa.from("polls")
      .select("id, slug, title, description, is_active, deleted_at, created_at, updated_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function listPollsForDashboardUser(userId) {
    const supa = init();
    const { data, error } = await supa.rpc("polls_for_dashboard_user", { p_user_id: userId });
    if (error) throw error;
    return data || [];
  }

  async function listPollsForRespondent(dashboardUserId) {
    const supa = init();
    const { data, error } = await supa.rpc("polls_for_respondent", {
      p_dashboard_user_id: dashboardUserId
    });
    if (error) throw error;
    return data || [];
  }

  async function getPollById(pollId) {
    const supa = init();
    const { data, error } = await supa.from("polls")
      .select("id, slug, title, description, is_active")
      .eq("id", pollId).single();
    if (error) throw error;
    return data;
  }

  function validatePollPayload({ title, slug, description }) {
    const errors = [];
    const cleanTitle = String(title || "").trim();
    const cleanSlug  = String(slug  || "").trim().toLowerCase();
    const cleanDesc  = String(description || "").trim();
    if (!cleanTitle) errors.push("Poll name is required.");
    else if (cleanTitle.length > LIMITS.POLL_TITLE_MAX) errors.push(`Name must be ${LIMITS.POLL_TITLE_MAX} characters or fewer.`);
    if (!cleanSlug) errors.push("Poll slug is required.");
    else if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(cleanSlug))
      errors.push("Slug must be lowercase letters, numbers, and dashes only.");
    else if (cleanSlug.length > LIMITS.POLL_SLUG_MAX)
      errors.push(`Slug must be ${LIMITS.POLL_SLUG_MAX} characters or fewer.`);
    if (cleanDesc.length > LIMITS.POLL_DESCRIPTION_MAX)
      errors.push(`Description must be ${LIMITS.POLL_DESCRIPTION_MAX} characters or fewer.`);
    return { errors, cleanTitle, cleanSlug, cleanDesc };
  }

  async function createPoll({ title, slug, description, isActive }) {
    const v = validatePollPayload({ title, slug, description });
    if (v.errors.length) { const e = new Error(v.errors[0]); e.validation = v.errors; throw e; }
    const supa = init();
    const { data, error } = await supa.from("polls").insert({
      title: v.cleanTitle,
      slug: v.cleanSlug,
      description: v.cleanDesc || null,
      is_active: isActive !== false
    }).select("id, slug, title, description, is_active").single();
    if (error) throw error;
    return data;
  }

  async function updatePoll(pollId, { title, description, isActive }) {
    const supa = init();
    const patch = { updated_at: new Date().toISOString() };
    if (title != null) {
      const t = String(title).trim();
      if (!t) throw new Error("Poll name cannot be empty.");
      if (t.length > LIMITS.POLL_TITLE_MAX) throw new Error(`Name must be ${LIMITS.POLL_TITLE_MAX} characters or fewer.`);
      patch.title = t;
    }
    if (description != null) {
      const d = String(description).trim();
      if (d.length > LIMITS.POLL_DESCRIPTION_MAX) throw new Error(`Description too long.`);
      patch.description = d || null;
    }
    if (isActive != null) patch.is_active = !!isActive;
    const { error } = await supa.from("polls").update(patch).eq("id", pollId);
    if (error) throw error;
  }

  async function archivePoll(pollId) {
    const supa = init();
    const now = new Date().toISOString();
    const { error } = await supa.from("polls")
      .update({ is_active: false, deleted_at: now, updated_at: now })
      .eq("id", pollId);
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Poll access mapping
  // -------------------------------------------------------
  async function getPollAccessMap(pollId) {
    const supa = init();
    const { data, error } = await supa.from("poll_user_access")
      .select("dashboard_user_id, is_enabled")
      .eq("poll_id", pollId);
    if (error) throw error;
    const map = new Map();
    (data || []).forEach((r) => map.set(r.dashboard_user_id, !!r.is_enabled));
    return map;
  }

  async function setPollUserAccess(pollId, dashboardUserId, isEnabled) {
    const supa = init();
    const { error } = await supa.from("poll_user_access")
      .upsert({ poll_id: pollId, dashboard_user_id: dashboardUserId, is_enabled: !!isEnabled, updated_at: new Date().toISOString() },
              { onConflict: "poll_id,dashboard_user_id" });
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Questions - scoped to a pollId
  // -------------------------------------------------------
  async function getActiveQuestions(pollId) {
    if (!pollId) return [];
    if (questionsCacheByPoll.has(pollId)) return questionsCacheByPoll.get(pollId);
    const supa = init();
    const { data, error } = await supa.from("questions")
      .select(`
        id, question_text, question_type, display_order, is_active, is_required, deleted_at,
        question_options ( id, option_text, option_value, display_order, is_active, deleted_at )
      `)
      .eq("poll_id", pollId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("display_order", { ascending: true });
    if (error) throw error;

    const out = (data || []).map((q) => ({
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
    questionsCacheByPoll.set(pollId, out);
    return out;
  }

  async function getNextQuestionOrder(pollId) {
    const supa = init();
    const { data, error } = await supa.from("questions")
      .select("display_order")
      .eq("poll_id", pollId)
      .order("display_order", { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data && data[0] && data[0].display_order) || 0) + 1;
  }

  function validateQuestionPayload({ text, type, required, options }) {
    const errors = [];
    const cleanText = String(text == null ? "" : text).trim();
    if (!cleanText) errors.push("Question text is required.");
    else if (cleanText.length > LIMITS.QUESTION_TEXT_MAX)
      errors.push(`Question must be ${LIMITS.QUESTION_TEXT_MAX} characters or fewer.`);

    const questionType = (type === "text_input") ? "text_input" : "single_select";
    let cleanOptions = [];
    if (questionType === "single_select") {
      const raw = Array.isArray(options) ? options : [];
      cleanOptions = raw.map((o) => String(o == null ? "" : o).trim()).filter((t) => t.length > 0);
      if (cleanOptions.length < LIMITS.OPTION_MIN) errors.push(`MCQ needs at least ${LIMITS.OPTION_MIN} non-blank options.`);
      if (cleanOptions.length > LIMITS.OPTION_MAX) errors.push(`MCQ allows at most ${LIMITS.OPTION_MAX} options.`);
      if (cleanOptions.some((t) => t.length > LIMITS.OPTION_TEXT_MAX))
        errors.push(`Each option must be ${LIMITS.OPTION_TEXT_MAX} characters or fewer.`);
      const lower = cleanOptions.map((t) => t.toLowerCase());
      if (new Set(lower).size < lower.length) errors.push("Options must be different from each other.");
    }
    return { errors, cleanText, cleanOptions, questionType, required: !!required };
  }

  async function createQuestionWithOptions({ pollId, text, type, required, options }) {
    if (!pollId) throw new Error("pollId required");
    const v = validateQuestionPayload({ text, type, required, options });
    if (v.errors.length) { const e = new Error(v.errors[0]); e.validation = v.errors; throw e; }
    const supa = init();
    const nextOrder = await getNextQuestionOrder(pollId);

    const { data: q, error: qErr } = await supa.from("questions").insert({
      poll_id: pollId,
      question_text: v.cleanText,
      question_type: v.questionType,
      display_order: nextOrder,
      is_active: true,
      is_required: v.required
    }).select("id").single();
    if (qErr) throw qErr;

    if (v.questionType === "single_select") {
      const rows = v.cleanOptions.map((t, i) => ({
        question_id: q.id, option_text: t, option_value: `opt_${i + 1}`, display_order: i + 1, is_active: true
      }));
      const { error: oErr } = await supa.from("question_options").insert(rows);
      if (oErr) { await supa.from("questions").delete().eq("id", q.id); throw oErr; }
    }
    invalidateCache(pollId);
    return q.id;
  }

  async function softDeleteQuestion(questionId, pollId) {
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
    invalidateCache(pollId);
  }

  // -------------------------------------------------------
  // Dashboard accounts (unchanged - kept here for completeness)
  // -------------------------------------------------------
  async function loginDashboardUser({ displayName, password }) {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_login", {
      p_display_name: displayName, p_password: password
    });
    if (error) throw error;
    return (data && data[0]) || null;
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
    const { error } = await init().rpc("dashboard_rename_user", { p_id: id, p_new_name: newName });
    if (error) throw error;
  }
  async function changeDashboardPassword(id, newPassword) {
    const { error } = await init().rpc("dashboard_change_password", { p_id: id, p_new_password: newPassword });
    if (error) throw error;
  }
  async function deleteDashboardUser(id) {
    const { error } = await init().rpc("dashboard_delete_user", { p_id: id });
    if (error) throw error;
  }

  async function resetPollData(pollId) {
    if (!pollId) throw new Error("pollId required");
    const { error } = await init().rpc("dashboard_reset_poll", { p_poll_id: pollId });
    if (error) throw error;
    invalidateCache(pollId);
  }

  // -------------------------------------------------------
  // Respondent / submissions
  // -------------------------------------------------------
  async function createUser({ fullName, sessionId }) {
    const supa = init();
    const { data, error } = await supa.from("users")
      .insert({ full_name: fullName, contact_value: null, session_id: sessionId || null })
      .select("id, full_name, session_id, created_at").single();
    if (error) throw error;
    return data;
  }

  async function submitPoll({ pollId, userId, assignedUserId, answers }) {
    if (!pollId) throw new Error("pollId required");
    if (!assignedUserId) throw new Error("assigned_user_id is required");
    const supa = init();

    const { data: submission, error: subErr } = await supa.from("submissions").insert({
      poll_id: pollId,
      user_id: userId,
      assigned_user_id: assignedUserId,
      status: "submitted"
    }).select("id, submitted_at").single();
    if (subErr) throw subErr;

    const rows = answers
      .filter((a) => !a.skipped)
      .map((a) => ({
        submission_id: submission.id,
        question_id: a.questionId,
        selected_option_id: a.optionId || null,
        selected_option_text: a.optionText || null,
        text_answer: a.textAnswer != null ? a.textAnswer : null
      }));
    if (rows.length) {
      const { error: ansErr } = await supa.from("answers").insert(rows);
      if (ansErr) throw ansErr;
    }
    return submission;
  }

  async function deleteSubmission(submissionId) {
    const { error } = await init().from("submissions").delete().eq("id", submissionId);
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Dashboard reads - scoped to pollId
  // -------------------------------------------------------
  function resolveAssignedUserFilter(filter) {
    const v = filter && filter.assignedUserId;
    if (!v || v === "all") return null;
    return v;
  }

  async function getAggregatedResults({ pollId, assignedUserId }) {
    const supa = init();
    const questions = await getActiveQuestions(pollId);
    const scoped = resolveAssignedUserFilter({ assignedUserId });

    const scaffold = questions.map((q) => ({
      id: q.id, text: q.text, type: q.type, required: q.required, order: q.order,
      options: q.options.map((o) => ({ id: o.id, text: o.text, value: o.value, order: o.order, count: 0 })),
      total: 0
    }));
    const activeOptionIds = new Set();
    const textQuestionIds = new Set();
    for (const q of scaffold) {
      if (q.type === "text_input") textQuestionIds.add(q.id);
      for (const o of q.options) activeOptionIds.add(o.id);
    }

    let query = supa.from("answers")
      .select("selected_option_id, question_id, text_answer, submission:submissions!inner(poll_id, assigned_user_id)")
      .eq("submission.poll_id", pollId);
    if (scoped) query = query.eq("submission.assigned_user_id", scoped);

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
    return { questions: scaffold };
  }

  async function getUserResponses({ pollId, assignedUserId }) {
    const supa = init();
    const scoped = resolveAssignedUserFilter({ assignedUserId });
    let query = supa.from("submissions").select(`
      id, submitted_at, status, assigned_user_id,
      user:users ( id, full_name, session_id ),
      assigned:assigned_user_id ( id, display_name ),
      answers (
        question_id, selected_option_text, text_answer,
        question:questions ( id, question_text, question_type, display_order, is_active, deleted_at )
      )
    `).eq("poll_id", pollId).order("submitted_at", { ascending: false });
    if (scoped) query = query.eq("assigned_user_id", scoped);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getTotalSubmissions({ pollId, assignedUserId }) {
    const supa = init();
    const scoped = resolveAssignedUserFilter({ assignedUserId });
    let query = supa.from("submissions").select("id", { count: "exact", head: true }).eq("poll_id", pollId);
    if (scoped) query = query.eq("assigned_user_id", scoped);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  // Poll-overview stats (for admin poll management row counts)
  async function getPollStats(pollId) {
    const supa = init();
    const [qRes, subRes, accRes] = await Promise.all([
      supa.from("questions").select("id", { count: "exact", head: true })
        .eq("poll_id", pollId).eq("is_active", true).is("deleted_at", null),
      supa.from("submissions").select("id", { count: "exact", head: true }).eq("poll_id", pollId),
      supa.from("poll_user_access").select("dashboard_user_id", { count: "exact", head: true })
        .eq("poll_id", pollId).eq("is_enabled", true)
    ]);
    return {
      questionCount:   qRes.count   || 0,
      submissionCount: subRes.count || 0,
      accessCount:     accRes.count || 0
    };
  }

  return {
    init, invalidateCache, LIMITS,
    // polls
    listAllPolls, listPollsForDashboardUser, listPollsForRespondent, getPollById,
    createPoll, updatePoll, archivePoll,
    getPollAccessMap, setPollUserAccess, getPollStats,
    // questions
    getActiveQuestions, getNextQuestionOrder, createQuestionWithOptions, softDeleteQuestion,
    // dashboard accounts
    loginDashboardUser, listDashboardUsers, getPollUserOptions,
    createDashboardUser, renameDashboardUser, changeDashboardPassword, deleteDashboardUser,
    // respondent + reset
    createUser, submitPoll, deleteSubmission, resetPollData,
    // dashboard reads
    getAggregatedResults, getUserResponses, getTotalSubmissions
  };
})();
