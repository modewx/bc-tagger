// "Select last import": select exactly the items the most recently committed
// import added or merged (GET /api/import/last-committed). Self-contained so
// it's easy to drop later: app.js only adds this button.

import { apiJson } from "../../shared/datasource/HttpDataSource";

// selectOnly(ids) replaces the selection and returns how many are in the collection.
export function selectLastImportButton(selectOnly) {
  return {
    id: "selectLastImport",
    label: "Select last import",
    title: "Select exactly the items the most recent Import selected added or merged (newest Modified first)",
    run: async (statusEl, button) => {
      button.disabled = true;
      try {
        const last = await apiJson("/api/import/last-committed");
        if (!last || !last.batch_id) {
          statusEl.textContent = "Select last import: nothing imported yet.";
        } else {
          const n = selectOnly(last.item_ids || []);
          const when = last.committed_at ? ` on ${new Date(last.committed_at).toLocaleString()}` : "";
          statusEl.textContent = `Selected the ${n} items of the last import (${last.name || last.batch_id}${when}), newest Modified first.`;
        }
      } catch (e) {
        statusEl.textContent = `Select last import: ${e.message}`;
      }
      button.disabled = false;
    },
  };
}
