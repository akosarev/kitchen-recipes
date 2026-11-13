// Loading and error states shown before the recipe list is available.

/** Shown when recipes cannot be fetched and no copy is cached (e.g. first launch offline). */
export const LOAD_ERROR_TEXT = "Couldn't load recipes. Connect once to download them.";

/**
 * @param {HTMLElement} app
 */
export function renderLoading(app) {
  document.title = "My recipes";
  app.innerHTML = `<div class="home">
    <h1>My recipes</h1>
    <p class="lead status" role="status" aria-live="polite">Loading recipes…</p>
  </div>`;
}

/**
 * @param {HTMLElement} app
 * @param {() => void} onRetry
 */
export function renderLoadError(app, onRetry) {
  document.title = "My recipes";
  app.innerHTML = `<div class="home">
    <h1>My recipes</h1>
    <p class="lead status error" role="alert">${LOAD_ERROR_TEXT}</p>
    <button type="button" class="retry">Try again</button>
  </div>`;
  app.querySelector("button.retry")?.addEventListener("click", onRetry);
}
