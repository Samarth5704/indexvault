// Dashboard (SPEC § 3.1): a 12-column grid of widgets. "Edit layout" turns on
// drag-to-move, resize handles and keyboard arranging; every change is saved to
// settings.dashboard.layout. An empty saved layout means the built-in default.

import { confirmDialog } from "../components/confirm.js";
import { emptyState } from "../components/feedback.js";
import { toast, toastError } from "../components/toast.js";
import { widgetGrid } from "../components/widget-grid.js";
import { h, icon } from "../dom.js";
import { findSpot, sameLayout } from "../grid-layout.js";
import { setPageParams } from "../router.js";
import { saveSection, settings } from "../settings.js";
import { store } from "../store.js";
import { defaultLayout, limitsFor, newId, openAddWidget, openConfigure, widgetCard } from "./dashboard/widgets.js";

const saved = () => settings().dashboard.layout;
const current = () => (saved().length ? saved().map((i) => ({ ...i })) : defaultLayout());

export default {
  mount(el, { route }) {
    let editing = route.params.edit === "1";
    const editBtn = h("button.btn.secondary.sm", { type: "button", onclick: () => setEditing(!editing) });
    const addBtn = h("button.btn.secondary.sm", { type: "button", onclick: add }, icon("plus", { size: "sm" }), "Add widget");
    const resetBtn = h("button.btn.ghost.sm", { type: "button", onclick: reset }, icon("refresh", { size: "sm" }), "Reset layout");
    const hint = h("p.dash-hint", { role: "status" });
    const empty = h("section.card", { hidden: true }, emptyState({ icon: "dashboard", title: "Your dashboard is empty",
      message: "Add widgets one by one, or bring back the default layout.", action: { label: "Add a widget", onClick: add } }));
    el.append(
      h("header.page-head",
        h("div", h("h1", "Dashboard"), h("p.page-sub", "Your market at a glance. Arrange it any way you like.")),
        h("div.head-actions", addBtn, resetBtn, editBtn)),
      hint);

    const grid = widgetGrid({
      layout: current(),
      label: "Dashboard widgets",
      limits: limitsFor,
      render: (item) => widgetCard(item, {
        onConfigure: (it) => openConfigure(grid.layout().find((x) => x.id === it.id) || it, (config) => setConfig(it.id, config, true)),
        onRemove: remove,
        saveConfig: (config) => setConfig(item.id, config, false),
      }),
      onChange: persist,
      onRemove: remove,
    });
    el.append(grid.el, empty);

    // ------------------------------------------------------------ actions
    function setEditing(on) {
      editing = on;
      grid.setEditing(on);
      editBtn.replaceChildren(icon(on ? "check" : "columns", { size: "sm" }), on ? "Done" : "Edit layout");
      editBtn.classList.toggle("primary", on);
      editBtn.classList.toggle("secondary", !on);
      editBtn.setAttribute("aria-pressed", String(on));
      addBtn.hidden = resetBtn.hidden = !on;
      hint.textContent = on
        ? "Drag a widget by its title bar, or pull its corner to resize. With the keyboard: Tab to a widget, arrows move it, Shift + arrows resize, Delete removes."
        : "";
      setPageParams(on ? { ...store.get().route.params, edit: "1" } : Object.fromEntries(Object.entries(store.get().route.params).filter(([k]) => k !== "edit")));
    }

    async function persist(layout) {
      empty.hidden = layout.length > 0;
      try {
        await saveSection("dashboard", { layout });
      } catch (e) {
        toastError(e, "Couldn't save the layout");
      }
    }

    function setConfig(id, config, rebuild) {
      const layout = grid.layout().map((i) => (i.id === id ? { ...i, config } : i));
      if (!layout.some((i) => i.id === id)) return; // widget was removed meanwhile
      if (rebuild) grid.setLayout(layout);
      else grid.setConfig(id, config);
      persist(layout);
    }

    function add() {
      openAddWidget(({ widget, config, w, h: ht }) => {
        const layout = grid.layout();
        const spot = findSpot(layout, w, ht);
        const item = { id: newId(), widget, config, w, h: ht, ...spot };
        grid.setLayout([...layout, item]);
        persist(grid.layout());
        if (!editing) setEditing(true);
        requestAnimationFrame(() => el.querySelector(`.wg-item[data-id="${item.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      });
    }

    function remove(item) {
      const before = grid.layout();
      const name = el.querySelector(`.wg-item[data-id="${item.id}"] .card-title`)?.textContent || "Widget";
      const hadFocus = el.querySelector(`.wg-item[data-id="${item.id}"]`)?.contains(document.activeElement);
      const order = [...el.querySelectorAll(".wg-item")].sort((a, b) => a.style.order - b.style.order).map((c) => c.dataset.id);
      const neighbour = order[order.indexOf(item.id) + 1] || order[order.indexOf(item.id) - 1];
      grid.setLayout(before.filter((i) => i.id !== item.id));
      persist(grid.layout());
      if (hadFocus) el.querySelector(`.wg-item[data-id="${neighbour}"]`)?.focus(); // keep keyboard users in the grid
      toast({ title: `Removed ${name}`, duration: 8000, action: { label: "Undo", onClick: () => { grid.setLayout(before); persist(before); } } });
    }

    async function reset() {
      const ok = await confirmDialog({ title: "Reset the dashboard layout?", confirmLabel: "Reset layout",
        message: "Your widgets, their settings and any notes go back to the default layout. Export a backup first (Settings → Backup) if you want to keep your notes." });
      if (!ok) return;
      grid.setLayout(defaultLayout());
      empty.hidden = true;
      try {
        await saveSection("dashboard", { layout: [] });
        toast({ tone: "success", title: "Dashboard reset" });
      } catch (e) { toastError(e, "Couldn't reset the layout"); }
    }

    // ------------------------------------------------------------ outside changes
    const unsubs = [
      // e.g. a backup restore or reset from Settings: follow it (our own saves echo back unchanged)
      store.subscribe((s) => s.settings?.dashboard.layout, () => {
        const next = current();
        if (!sameLayout(next, grid.layout()) && !(saved().length === 0 && !grid.layout().length)) grid.setLayout(next);
      }),
      store.subscribe((s) => s.settings?.data.source, () => grid.refreshAll()),
      store.subscribe((s) => JSON.stringify(s.settings?.formats), () => grid.refreshAll()), // saves return new objects; compare by value
      store.subscribe((s) => s.catalog, () => grid.refreshAll()),
      store.subscribe((s) => s.route.params.edit, (v) => {
        if (store.get().route.page === "dashboard" && (v === "1") !== editing) setEditing(v === "1"); // e.g. from the command palette
      }),
    ];
    setEditing(editing);
    return () => {
      unsubs.forEach((u) => u());
      grid.destroy();
    };
  },
};
