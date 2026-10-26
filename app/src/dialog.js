// A modal confirm dialog (native <dialog>), for decisions that need more than
// window.confirm: a formatted body, a danger style, and optionally a checkbox
// the user must tick before the confirm button enables.

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Node|string} o.body
 * @param {string} [o.confirmLabel]
 * @param {string} [o.cancelLabel]
 * @param {boolean} [o.danger]       red confirm button and header
 * @param {string} [o.requireAck]    label of a checkbox that must be ticked first
 * @param {string} [o.id]            element id (tests)
 * @returns {Promise<boolean>}
 */
export function confirmDialog(o) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "confirm-dialog" + (o.danger ? " danger" : "");
    if (o.id) dlg.id = o.id;

    const title = document.createElement("h3");
    title.textContent = o.title;
    const body = document.createElement("div");
    body.className = "dialog-body";
    body.append(typeof o.body === "string" ? document.createTextNode(o.body) : o.body);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary dialog-cancel";
    cancel.textContent = o.cancelLabel || "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "dialog-confirm" + (o.danger ? " danger" : "");
    ok.textContent = o.confirmLabel || "Confirm";

    dlg.append(title, body);
    if (o.requireAck) {
      const label = document.createElement("label");
      label.className = "dialog-ack";
      const box = document.createElement("input");
      box.type = "checkbox";
      label.append(box, " " + o.requireAck);
      ok.disabled = true;
      box.addEventListener("change", () => (ok.disabled = !box.checked));
      dlg.append(label);
    }
    actions.append(cancel, ok);
    dlg.append(actions);
    document.body.appendChild(dlg);

    const done = (result) => {
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault(); // Escape
      done(false);
    });
    dlg.showModal();
    cancel.focus(); // the safe choice is the default
  });
}
