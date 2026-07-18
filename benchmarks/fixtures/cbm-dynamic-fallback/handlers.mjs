// Event handlers looked up dynamically by registry.mjs via a computed
// `handle${Type}` key -- there is no static call site naming these functions
// directly, so a graph-based index can't point from "refund event" to this
// file without evaluating the dynamic key at runtime.
export function handleOrder(payload) {
  return { orderId: payload.orderId, status: "placed" };
}

export function handlePayment(payload) {
  return { orderId: payload.orderId, charged: payload.amount };
}

// BENCHMARK: add a `handleRefund(payload)` export here returning
// `{ orderId: payload.orderId, refunded: payload.amount }` so
// `dispatch("refund", payload)` resolves it.
