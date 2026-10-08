// Placeholder for pages built in later milestones.

import { emptyState } from "../components/feedback.js";
import { h } from "../dom.js";
import { navigate } from "../router.js";
import { ROUTE_BY_ID } from "../routes.js";

export default {
  mount(el, { route }) {
    const r = ROUTE_BY_ID[route.page];
    el.append(
      h("header.page-head", h("div", h("h1", r.label), h("p.page-sub", r.blurb))),
      h("section.card.placeholder-card", emptyState({
        icon: r.icon,
        title: `${r.label} arrives in Milestone ${r.milestone}`,
        message: "The data behind it is ready in the API. The shell, selection and settings already work here.",
        action: { label: "Back to Dashboard", onClick: () => navigate("dashboard") },
      })));
  },
};
