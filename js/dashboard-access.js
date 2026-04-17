/**
 * Swift Poll - dashboard access gate.
 *
 * Requires both a user selection (to scope the dashboard view)
 * and the shared DASHBOARD_PASSCODE. On success we stash the
 * selected user in sessionStorage and forward to the dashboard.
 */
(function () {
  const CFG = window.SWIFT_POLL_CONFIG || {};
  const STORAGE_KEYS = (window.SP && SP.utils && SP.utils.STORAGE_KEYS) || {};
  const SESSION_KEY = "dashboardUser";

  document.addEventListener("DOMContentLoaded", () => {
    SP.utils.setHeaderBrand();

    const form     = document.querySelector("[data-access-form]");
    const select   = document.querySelector("[data-access-user-select]");
    const password = document.querySelector("[name='accessPassword']");
    const errorBox = document.querySelector("[data-access-error]");

    // Already authenticated in this tab? Skip straight through.
    if (sessionStorage.getItem(SESSION_KEY)) {
      window.location.replace("dashboard.html");
      return;
    }

    // Populate the user dropdown from config
    const users = Array.isArray(CFG.ASSIGNED_USERS) ? CFG.ASSIGNED_USERS : [];
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All Users";
    select.appendChild(allOpt);
    for (const u of users) {
      const opt = document.createElement("option");
      opt.value = u.value;
      opt.textContent = u.label;
      select.appendChild(opt);
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      errorBox.textContent = "";

      const chosen = (select.value || "").trim();
      const entered = (password.value || "").trim();
      const expected = String(CFG.DASHBOARD_PASSCODE || "").trim();

      if (!chosen) {
        errorBox.textContent = "Please select a user to continue.";
        select.focus();
        return;
      }
      if (!entered) {
        errorBox.textContent = "Please enter the dashboard password.";
        password.focus();
        return;
      }
      if (!expected) {
        errorBox.textContent =
          "No dashboard password is configured. Set DASHBOARD_PASSCODE in js/config.js.";
        return;
      }
      if (entered !== expected) {
        errorBox.textContent = "Incorrect password. Please try again.";
        password.value = "";
        password.focus();
        return;
      }

      sessionStorage.setItem(SESSION_KEY, chosen);
      // Keep the legacy auth key in sync so any stray code paths
      // that still check localStorage do not re-prompt.
      try {
        if (STORAGE_KEYS.DASH_AUTH) localStorage.setItem(STORAGE_KEYS.DASH_AUTH, entered);
      } catch (_) {}

      window.location.replace("dashboard.html");
    });
  });
})();
