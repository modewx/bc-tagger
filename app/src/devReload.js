// Dev loop: reload the page when the server reports a new build (app/dist or
// the dev extension changed; `npm run watch:app` / `watch:dev`). An extension
// rebuild also orphans this page's bridge content script, so a reload is
// needed then anyway. Waits while audio is playing.

import { apiJson } from "../../shared/datasource/HttpDataSource";

export function startDevReload(intervalMs = 3000) {
  let first = null;
  const playing = () => [...document.querySelectorAll("audio")].some((a) => !a.paused);
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const { build_id } = await apiJson("/api/dev/build-id");
      if (first === null) first = build_id;
      else if (build_id !== first && !playing()) location.reload();
    } catch (e) {
      /* server restarting */
    }
  }, intervalMs);
}
