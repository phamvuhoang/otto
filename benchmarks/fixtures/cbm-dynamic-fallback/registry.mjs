import * as handlers from "./handlers.mjs";

// Dynamic dispatch: the handler function is selected by a string key built
// at runtime (`handle${capitalize(eventType)}`), so there is no static call
// site naming any individual handler -- a codebase-memory graph index only
// sees the module-level import of handlers.mjs here, not which export a
// given eventType resolves to. Answering "what handles a 'refund' event"
// needs raw text search (e.g. grep for `handleRefund`) to defer to, not
// graph traversal.
function capitalize(s) {
  return s[0].toUpperCase() + s.slice(1);
}

export function dispatch(eventType, payload) {
  const fn = handlers[`handle${capitalize(eventType)}`];
  if (typeof fn !== "function") {
    throw new Error(`no handler for event type: ${eventType}`);
  }
  return fn(payload);
}
