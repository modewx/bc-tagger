// Settings → Test: actions for trying things out on the latest 10 tagged
// items, kept off the collection's toolbar (which acts on the selected or
// shown items). Same jobs and the same export dry run + confirm.

import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { runExport } from "./exportFlow";

function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (k === "class" ? (n.className = v) : n.setAttribute(k, v)));
  n.append(...children);
  return n;
}

export function createTestTab(container) {
  const jobs = new Jobs(new ServerEvents().start());
  // The id the collection page uses too, so the same checks read it.
  const status = node("span", { id: "refreshStatus", class: "help test-status" });
  const button = (id, label, title, start) => {
    const b = node("button", { type: "button", id, title }, label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      status.textContent = `${label}: starting…`;
      let job;
      try {
        job = await start((j) => (status.textContent = `${label}: ${progressText(j)}`));
      } catch (e) {
        job = { status: "error", error: e.message };
      }
      status.textContent = `${label}: ${resultText(job)}`;
      b.disabled = false;
    });
    return b;
  };
  container.append(
    node(
      "section",
      { id: "sec_test", "data-tab": "test" },
      node("h2", {}, "Test"),
      node(
        "p",
        { class: "help" },
        "For trying things out: these act on the 10 most recently tagged items. The collection's toolbar acts on the " +
          "selected (or shown) items instead."
      ),
      node(
        "div",
        { class: "field test-actions" },
        button("locateLatest", "Locate latest 10", "Match the 10 most recently tagged items to local files", (p) =>
          jobs.run("/api/locate", { latest: 10 }, p)
        ),
        " ",
        button(
          "exportLatest",
          "Export latest 10 to rekordbox",
          "Add the 10 most recent located items to rekordbox, one playlist per tag (previews and asks on the main library)",
          (p) => runExport(jobs, { latest: 10 }, p)
        )
      ),
      node("div", { class: "field" }, status)
    )
  );
}
