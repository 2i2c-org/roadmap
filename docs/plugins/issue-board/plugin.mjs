// Issue Board Plugin for MyST
//
// Provides the `{issue-board}` directive that renders a list of 2i2c platform
// initiatives grouped by project board status (e.g. "In flight", "Done").
// Data is fetched from GitHub (see fetch.mjs) and rendered as expandable
// details elements (see render.mjs).

import { fetchData } from "./fetch.mjs";
import { renderItem } from "./render.mjs";

const issueBoardDirective = {
  name: "issue-board",
  doc: "Display initiatives from the 2i2c project board filtered by status.",
  arg: { type: String, doc: "Project board status (e.g. 'P&S Initiatives in flight', 'Done')" },
  run(data, vfile, ctx) {
    let allItems;
    try {
      allItems = fetchData();
    } catch (err) {
      console.error("issue-board: failed to fetch data:", err.message);
      return [];
    }

    let filtered = allItems.filter((item) => item.status === data.arg);

    // "Done" items: only show completed (not duplicated/not-planned), newest first
    if (data.arg === "Done") {
      filtered = filtered
        .filter((item) => item.stateReason === "COMPLETED")
        .sort((a, b) => new Date(b.closedAt || 0) - new Date(a.closedAt || 0));
    }

    return [{
      type: "div",
      class: "issue-board",
      children: filtered.map((item) => renderItem(item, ctx)),
    }];
  },
};

export default {
  name: "Issue Board Plugin",
  directives: [issueBoardDirective],
};
