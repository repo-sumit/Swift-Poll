/**
 * Swift Poll - dashboard access gate.
 *
 * Loads the active dashboard user list dynamically and validates
 * credentials via the `dashboard_login` RPC (bcrypt check in DB).
 * On success, stores { id, displayName, role } in sessionStorage
 * and forwards to the dashboard.
 */
(function () {
  const SESSION_KEY = "swift_poll.dashboard_session";

  document.addEventListener("DOMContentLoaded", async () => {
    SP.utils.setHeaderBrand();

    const form     = document.querySelector("[data-access-form]");
    const select   = document.querySelector("[data-access-user-select]");
    const password = document.querySelector("[name='accessPassword']");
    const errorBox = document.querySelector("[data-access-error]");
    const submit   = form.querySelector("button[type='submit']");

    // Already authenticated in this tab? Forward through.
    if (getSession()) {
      window.location.replace("dashboard.html");
      return;
    }

    // Populate the user dropdown from the DB
    try {
      const users = await SP.db.listDashboardUsers();
      for (const u of users) {
        const opt = document.createElement("option");
        opt.value = u.display_name;
        opt.textContent = u.display_name + (u.role === "admin" ? " (Admin)" : "");
        select.appendChild(opt);
      }
    } catch (err) {
      console.error(err);
      errorBox.textContent = friendlyError(err, "Could not load accounts.");
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.textContent = "";

      const chosen  = (select.value || "").trim();
      const entered = (password.value || "").trim();

      if (!chosen)  { errorBox.textContent = "Please select a user to continue."; select.focus(); return; }
      if (!entered) { errorBox.textContent = "Please enter your password."; password.focus(); return; }

      submit.disabled = true;
      submit.textContent = "Signing in...";
      try {
        const match = await SP.db.loginDashboardUser({ displayName: chosen, password: entered });
        if (!match) {
          errorBox.textContent = "Incorrect user or password.";
          password.value = "";
          password.focus();
          return;
        }
        setSession({ id: match.id, displayName: match.display_name, role: match.role });
        window.location.replace("dashboard.html");
      } catch (err) {
        console.error(err);
        errorBox.textContent = friendlyError(err, "Could not sign you in. Please try again.");
      } finally {
        submit.disabled = false;
        submit.textContent = "Continue";
      }
    });
  });

  function setSession(obj) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj)); } catch (_) {}
  }
  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function friendlyError(err, fallback) {
    const msg = (err && (err.message || err.error_description)) || "";
    if (/Supabase URL not configured|Supabase client library not loaded/i.test(msg))
      return "App is not configured yet. Add your Supabase keys in js/config.js.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Network issue. Please try again.";
    if (/function .* does not exist/i.test(msg)) return "Database is out of date. Re-run supabase-schema.sql.";
    return fallback + (msg ? " (" + msg + ")" : "");
  }
})();
