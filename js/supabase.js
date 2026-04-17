/**
 * Swift Poll - Supabase client + data-access layer.
 *
 * Loads the Supabase JS client from CDN (see HTML <script>),
 * initialises it with the credentials from config.js, and
 * exposes a small typed-ish helper surface used by poll.js
 * and dashboard.js.
 */

window.SP = window.SP || {};

SP.db = (function () {
  const cfg = window.SWIFT_POLL_CONFIG || {};
  let client = null;
  let pollRecord = null;          // { id, slug, title, ... }
  let questionIndex = null;       // { [question_text]: { id, options: { [option_value]: { id, text } } } }

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

  /**
   * Fetches the poll, its questions, and all options in a single
   * call, then caches them in an index keyed by question text +
   * option value so we can translate config.js entries into the
   * UUIDs Supabase needs.
   */
  async function loadPollGraph() {
    if (pollRecord && questionIndex) return { poll: pollRecord, index: questionIndex };
    const supa = init();

    const { data: poll, error: pollErr } = await supa
      .from("polls")
      .select("id, slug, title, description")
      .eq("slug", cfg.POLL_SLUG)
      .single();
    if (pollErr) throw pollErr;

    const { data: questions, error: qErr } = await supa
      .from("questions")
      .select("id, question_text, display_order, is_active, question_options(id, option_text, option_value, display_order)")
      .eq("poll_id", poll.id)
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    if (qErr) throw qErr;

    const index = {};
    for (const q of questions || []) {
      const opts = {};
      for (const o of q.question_options || []) {
        opts[o.option_value] = { id: o.id, text: o.option_text };
      }
      index[q.question_text] = { id: q.id, order: q.display_order, options: opts };
    }
    pollRecord = poll;
    questionIndex = index;
    return { poll, index };
  }

  async function createUser({ fullName, contact, sessionId }) {
    const supa = init();
    const payload = {
      full_name: fullName,
      contact_value: contact || null,
      session_id: sessionId || null
    };
    const { data, error } = await supa
      .from("users")
      .insert(payload)
      .select("id, full_name, contact_value, session_id, created_at")
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * Persists a whole submission: creates the submission row,
   * then bulk-inserts answers. Each answer stores a text snapshot
   * so analytics survive future option edits.
   *
   * @param {Object} args
   * @param {string} args.userId
   * @param {Array<{questionText:string, optionValue:string}>} args.answers
   */
  async function submitPoll({ userId, answers }) {
    const supa = init();
    const { poll, index } = await loadPollGraph();

    // Map config-shaped answers into Supabase ids
    const rows = [];
    for (const a of answers) {
      const q = index[a.questionText];
      if (!q) throw new Error(`Question not found in Supabase: "${a.questionText}"`);
      const opt = q.options[a.optionValue];
      if (!opt) throw new Error(`Option "${a.optionValue}" not found for question`);
      rows.push({
        question_id: q.id,
        selected_option_id: opt.id,
        selected_option_text: opt.text
      });
    }

    const { data: submission, error: subErr } = await supa
      .from("submissions")
      .insert({ poll_id: poll.id, user_id: userId, status: "submitted" })
      .select("id, submitted_at")
      .single();
    if (subErr) throw subErr;

    const answerRows = rows.map((r) => ({ ...r, submission_id: submission.id }));
    const { error: ansErr } = await supa.from("answers").insert(answerRows);
    if (ansErr) throw ansErr;

    return submission;
  }

  // -------------------------------------------------------
  // Dashboard queries
  // -------------------------------------------------------
  async function getAggregatedResults() {
    const supa = init();
    const { poll, index } = await loadPollGraph();

    // Build question/option scaffold from cached graph so empty
    // options still render with a zero count.
    const questions = Object.entries(index)
      .map(([text, q]) => ({
        id: q.id,
        text,
        order: q.order,
        options: Object.entries(q.options)
          .map(([value, o]) => ({ id: o.id, text: o.text, value, count: 0 }))
          .sort((a, b) => a.text.localeCompare(b.text))
      }))
      .sort((a, b) => a.order - b.order);

    // One query returns every answer for this poll. Counts are
    // tallied client-side - fine for the free-tier volumes this
    // app targets.
    const { data: rows, error } = await supa
      .from("answers")
      .select("selected_option_id, question_id, submission:submissions!inner(poll_id)")
      .eq("submission.poll_id", poll.id);
    if (error) throw error;

    const byOption = new Map();
    for (const r of rows || []) byOption.set(r.selected_option_id, (byOption.get(r.selected_option_id) || 0) + 1);

    for (const q of questions) {
      for (const o of q.options) o.count = byOption.get(o.id) || 0;
      q.total = q.options.reduce((s, o) => s + o.count, 0);
    }

    return { poll, questions };
  }

  async function getUserResponses() {
    const supa = init();
    const { poll } = await loadPollGraph();

    const { data, error } = await supa
      .from("submissions")
      .select(`
        id,
        submitted_at,
        status,
        user:users ( id, full_name, contact_value, session_id ),
        answers (
          question_id,
          selected_option_text,
          question:questions ( question_text, display_order )
        )
      `)
      .eq("poll_id", poll.id)
      .order("submitted_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getTotalSubmissions() {
    const supa = init();
    const { poll } = await loadPollGraph();
    const { count, error } = await supa
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("poll_id", poll.id);
    if (error) throw error;
    return count || 0;
  }

  return {
    init,
    loadPollGraph,
    createUser,
    submitPoll,
    getAggregatedResults,
    getUserResponses,
    getTotalSubmissions
  };
})();
