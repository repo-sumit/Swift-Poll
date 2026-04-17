/**
 * Swift Poll - landing page script.
 * Wires up the header brand and the two primary CTAs.
 */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    SP.utils.setHeaderBrand();

    const cfg = window.SWIFT_POLL_CONFIG || {};
    const introEl = document.querySelector("[data-poll-intro]");
    if (introEl && cfg.POLL_INTRO) introEl.textContent = cfg.POLL_INTRO;

    const year = document.querySelector("[data-year]");
    if (year) year.textContent = new Date().getFullYear();

    document.querySelectorAll("[data-cta='start']").forEach((btn) => {
      btn.addEventListener("click", () => { window.location.href = "poll.html"; });
    });
    document.querySelectorAll("[data-cta='dashboard']").forEach((btn) => {
      btn.addEventListener("click", () => { window.location.href = "dashboard.html"; });
    });
  });
})();
