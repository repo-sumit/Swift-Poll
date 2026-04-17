/**
 * Swift Poll - tiny utility helpers shared across pages.
 * Deliberately dependency-free.
 */

window.SP = window.SP || {};

SP.utils = (function () {
  const STORAGE_KEYS = {
    SESSION_ID: "swift_poll.session_id",
    DRAFT:      "swift_poll.draft",
    USER:       "swift_poll.user",
    DASH_AUTH:  "swift_poll.dashboard_auth"
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // RFC4122 v4 fallback
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getSessionId() {
    let id = localStorage.getItem(STORAGE_KEYS.SESSION_ID);
    if (!id) {
      id = "sp_" + uuid();
      localStorage.setItem(STORAGE_KEYS.SESSION_ID, id);
    }
    return id;
  }

  function saveDraft(draft) {
    try { localStorage.setItem(STORAGE_KEYS.DRAFT, JSON.stringify(draft)); } catch (_) {}
  }
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.DRAFT) || "null"); }
    catch (_) { return null; }
  }
  function clearDraft() { localStorage.removeItem(STORAGE_KEYS.DRAFT); }

  function saveUser(user) {
    try { localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user)); } catch (_) {}
  }
  function loadUser() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.USER) || "null"); }
    catch (_) { return null; }
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function formatDate(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "sp-toast " + (kind === "error" ? "sp-toast--error" : "sp-toast--ok");
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("sp-toast--show"));
    setTimeout(() => {
      el.classList.remove("sp-toast--show");
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }

  function setHeaderBrand() {
    const cfg = window.SWIFT_POLL_CONFIG || {};
    document.querySelectorAll("[data-brand-logo]").forEach((n) => { n.src = cfg.BRAND_LOGO; n.alt = cfg.BRAND_NAME; });
    document.querySelectorAll("[data-brand-name]").forEach((n) => { n.textContent = cfg.BRAND_NAME; });
  }

  return {
    STORAGE_KEYS,
    uuid, getSessionId,
    saveDraft, loadDraft, clearDraft,
    saveUser, loadUser,
    escapeHtml, formatDate,
    toast, setHeaderBrand
  };
})();
