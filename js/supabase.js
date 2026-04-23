/**
 * Swift Poll - Supabase client + data-access layer.
 *
 * Admin writes are enforced at the database: every admin RPC
 * validates a session token tied to an active admin. The client
 * holds that token in sessionStorage and passes it on every call.
 */

window.SP = window.SP || {};

SP.db = (function () {
  const cfg = window.SWIFT_POLL_CONFIG || {};
  let client = null;
  const questionsCacheByPoll = new Map();

  const SESSION_KEY = "swift_poll.dashboard_session";

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

  const POLL_STATUS = ["draft", "active", "archived"];

  function init() {
    if (client) return client;
    if (!window.supabase || !window.supabase.createClient) throw new Error("Supabase client library not loaded");
    if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT-REF"))
      throw new Error("Supabase URL not configured - edit js/config.js");
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });
    return client;
  }

  function invalidateCache(pollId) {
    if (pollId) questionsCacheByPoll.delete(pollId); else questionsCacheByPoll.clear();
  }

  // -------------------------------------------------------
  // Session helpers - expose token for admin RPCs
  // -------------------------------------------------------
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_) { return null; }
  }
  function adminToken() {
    const s = readSession();
    return (s && s.role === "admin") ? s.token : null;
  }
  function requireToken() {
    const t = adminToken();
    if (!t) throw new Error("unauthorized");
    return t;
  }

  // -------------------------------------------------------
  // Auth
  // -------------------------------------------------------
  async function loginDashboardUser({ displayName, password }) {
    const supa = init();
    const { data, error } = await supa.rpc("dashboard_login", {
      p_display_name: displayName, p_password: password
    });
    if (error) throw error;
    return (data && data[0]) || null;  // { id, display_name, role, token }
  }

  async function logoutDashboardUser(token) {
    if (!token) return;
    try { await init().rpc("dashboard_logout", { p_token: token }); } catch (_) {}
  }

  async function listDashboardUsers() {
    const { data, error } = await init().rpc("dashboard_list_users");
    if (error) throw error;
    return data || [];
  }

  async function getPollUserOptions() {
    const { data, error } = await init().rpc("dashboard_active_user_accounts");
    if (error) throw error;
    return data || [];
  }

  // -------------------------------------------------------
  // Polls (reads + admin writes via RPC)
  // -------------------------------------------------------
  async function listAllPolls() {
    const { data, error } = await init().from("polls")
      .select("id, slug, title, description, status, created_at, updated_at")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function listPollsForDashboardUser(userId) {
    const { data, error } = await init().rpc("polls_for_dashboard_user", { p_user_id: userId });
    if (error) throw error;
    return data || [];
  }

  async function listPollsForRespondent(dashboardUserId) {
    const { data, error } = await init().rpc("polls_for_respondent", { p_dashboard_user_id: dashboardUserId });
    if (error) throw error;
    return data || [];
  }

  function validatePollPayload({ title, slug, description }) {
    const errors = [];
    const t = String(title || "").trim();
    const s = String(slug  || "").trim().toLowerCase();
    const d = String(description || "").trim();
    if (!t) errors.push("Poll name is required.");
    else if (t.length > LIMITS.POLL_TITLE_MAX) errors.push(`Name must be ${LIMITS.POLL_TITLE_MAX} characters or fewer.`);
    if (!s) errors.push("Poll slug is required.");
    else if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s))
      errors.push("Slug must be lowercase letters, numbers, and dashes only.");
    else if (s.length > LIMITS.POLL_SLUG_MAX)
      errors.push(`Slug must be ${LIMITS.POLL_SLUG_MAX} characters or fewer.`);
    if (d.length > LIMITS.POLL_DESCRIPTION_MAX)
      errors.push(`Description must be ${LIMITS.POLL_DESCRIPTION_MAX} characters or fewer.`);
    return { errors, t, s, d };
  }

  async function createPoll({ title, slug, description }) {
    const v = validatePollPayload({ title, slug, description });
    if (v.errors.length) { const e = new Error(v.errors[0]); e.validation = v.errors; throw e; }
    const { data, error } = await init().rpc("admin_create_poll", {
      p_token: requireToken(), p_title: v.t, p_slug: v.s, p_description: v.d
    });
    if (error) throw error;
    return { id: data, title: v.t, slug: v.s, description: v.d, status: "draft" };
  }

  async function updatePoll(pollId, { title, description, status }) {
    if (!POLL_STATUS.includes(status)) throw new Error("invalid status");
    const { error } = await init().rpc("admin_update_poll", {
      p_token: requireToken(),
      p_id: pollId,
      p_title: title == null ? "" : title,
      p_description: description == null ? null : description,
      p_status: status
    });
    if (error) throw error;
  }

  async function archivePoll(pollId) {
    return updatePoll(pollId, { title: null, description: null, status: "archived" });
  }

  async function duplicatePoll(pollId, { newSlug, newTitle } = {}) {
    const { data, error } = await init().rpc("admin_duplicate_poll", {
      p_token: requireToken(),
      p_source_id: pollId,
      p_new_slug:  newSlug  || "",
      p_new_title: newTitle || ""
    });
    if (error) throw error;
    return data;
  }

  // -------------------------------------------------------
  // Poll access map
  // -------------------------------------------------------
  async function getPollAccessMap(pollId) {
    const { data, error } = await init().from("poll_user_access")
      .select("dashboard_user_id, is_enabled").eq("poll_id", pollId);
    if (error) throw error;
    const map = new Map();
    (data || []).forEach((r) => map.set(r.dashboard_user_id, !!r.is_enabled));
    return map;
  }

  async function setPollUserAccess(pollId, userId, isEnabled) {
    const { error } = await init().rpc("admin_set_poll_access", {
      p_token: requireToken(), p_poll_id: pollId, p_user_id: userId, p_enabled: !!isEnabled
    });
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Questions (reads + admin writes via RPC)
  // -------------------------------------------------------
  async function getActiveQuestions(pollId) {
    if (!pollId) return [];
    if (questionsCacheByPoll.has(pollId)) return questionsCacheByPoll.get(pollId);
    const { data, error } = await init().from("questions")
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
      id: q.id, text: q.question_text, type: q.question_type || "single_select",
      required: !!q.is_required, order: q.display_order,
      options: (q.question_options || [])
        .filter((o) => o.is_active && !o.deleted_at)
        .sort((a, b) => a.display_order - b.display_order)
        .map((o) => ({ id: o.id, text: o.option_text, value: o.option_value, order: o.display_order }))
    }));
    questionsCacheByPoll.set(pollId, out);
    return out;
  }

  function validateQuestionPayload({ text, type, required, options }) {
    const errors = [];
    const cleanText = String(text || "").trim();
    if (!cleanText) errors.push("Question text is required.");
    else if (cleanText.length > LIMITS.QUESTION_TEXT_MAX)
      errors.push(`Question must be ${LIMITS.QUESTION_TEXT_MAX} characters or fewer.`);
    const questionType = (type === "text_input") ? "text_input" : "single_select";
    let cleanOptions = [];
    if (questionType === "single_select") {
      const raw = Array.isArray(options) ? options : [];
      cleanOptions = raw.map((o) => String(o || "").trim()).filter((t) => t.length > 0);
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
    const { data, error } = await init().rpc("admin_create_question", {
      p_token: requireToken(),
      p_poll_id: pollId,
      p_text: v.cleanText,
      p_type: v.questionType,
      p_is_required: v.required,
      p_options: v.questionType === "single_select" ? v.cleanOptions : null
    });
    if (error) throw error;
    invalidateCache(pollId);
    return data;
  }

  async function softDeleteQuestion(questionId, pollId) {
    const { error } = await init().rpc("admin_delete_question", {
      p_token: requireToken(), p_question_id: questionId
    });
    if (error) throw error;
    invalidateCache(pollId);
  }

  // -------------------------------------------------------
  // Users (admin)
  // -------------------------------------------------------
  async function createDashboardUser({ displayName, password }) {
    const { data, error } = await init().rpc("admin_create_user", {
      p_token: requireToken(), p_display_name: displayName, p_password: password
    });
    if (error) throw error;
    return data;
  }
  async function renameDashboardUser(id, newName) {
    const { error } = await init().rpc("admin_rename_user", {
      p_token: requireToken(), p_id: id, p_new_name: newName
    });
    if (error) throw error;
  }
  async function changeDashboardPassword(id, newPassword) {
    const { error } = await init().rpc("admin_change_password", {
      p_token: requireToken(), p_id: id, p_new_password: newPassword
    });
    if (error) throw error;
  }
  async function deleteDashboardUser(id) {
    const { error } = await init().rpc("admin_delete_user", { p_token: requireToken(), p_id: id });
    if (error) throw error;
  }

  async function resetPollData(pollId) {
    const { error } = await init().rpc("admin_reset_poll", { p_token: requireToken(), p_poll_id: pollId });
    if (error) throw error;
    invalidateCache(pollId);
  }

  async function deleteSubmission(submissionId) {
    const { error } = await init().rpc("admin_delete_submission", {
      p_token: requireToken(), p_submission_id: submissionId
    });
    if (error) throw error;
  }

  // -------------------------------------------------------
  // Respondent
  // -------------------------------------------------------
  async function createUser({ fullName, sessionId }) {
    const { data, error } = await init().from("users")
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
      poll_id: pollId, user_id: userId, assigned_user_id: assignedUserId, status: "submitted"
    }).select("id, submitted_at").single();
    if (subErr) throw subErr;
    const rows = answers.filter((a) => !a.skipped).map((a) => ({
      submission_id: submission.id, question_id: a.questionId,
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

  // -------------------------------------------------------
  // Dashboard reads
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
      if (r.selected_option_id && activeOptionIds.has(r.selected_option_id))
        byOption.set(r.selected_option_id, (byOption.get(r.selected_option_id) || 0) + 1);
      if (r.text_answer && textQuestionIds.has(r.question_id))
        textCounts.set(r.question_id, (textCounts.get(r.question_id) || 0) + 1);
    }
    for (const q of scaffold) {
      if (q.type === "single_select") {
        for (const o of q.options) o.count = byOption.get(o.id) || 0;
        q.total = q.options.reduce((s, o) => s + o.count, 0);
      } else q.total = textCounts.get(q.id) || 0;
    }
    return { questions: scaffold };
  }

  async function getUserResponses({ pollId, assignedUserId }) {
    const scoped = resolveAssignedUserFilter({ assignedUserId });
    let query = init().from("submissions").select(`
      id, submitted_at, status, assigned_user_id,
      user:users ( id, full_name, session_id ),
      assigned:assigned_user_id ( id, display_name ),
      answers ( question_id, selected_option_text, text_answer,
        question:questions ( id, question_text, question_type, display_order, is_active, deleted_at )
      )
    `).eq("poll_id", pollId).order("submitted_at", { ascending: false });
    if (scoped) query = query.eq("assigned_user_id", scoped);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getTotalSubmissions({ pollId, assignedUserId }) {
    const scoped = resolveAssignedUserFilter({ assignedUserId });
    let query = init().from("submissions").select("id", { count: "exact", head: true }).eq("poll_id", pollId);
    if (scoped) query = query.eq("assigned_user_id", scoped);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

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
    init, invalidateCache, LIMITS, POLL_STATUS,
    loginDashboardUser, logoutDashboardUser,
    listAllPolls, listPollsForDashboardUser, listPollsForRespondent,
    createPoll, updatePoll, archivePoll, duplicatePoll,
    getPollAccessMap, setPollUserAccess, getPollStats,
    getActiveQuestions, createQuestionWithOptions, softDeleteQuestion,
    listDashboardUsers, getPollUserOptions,
    createDashboardUser, renameDashboardUser, changeDashboardPassword, deleteDashboardUser,
    createUser, submitPoll, deleteSubmission, resetPollData,
    getAggregatedResults, getUserResponses, getTotalSubmissions
  };
})();
