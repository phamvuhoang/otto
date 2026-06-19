// A minimal stack. Deliberate bug for the benchmark: peek() returns the bottom
// element instead of the top.
export class Stack {
  #items = [];
  push(x) {
    this.#items.push(x);
  }
  pop() {
    return this.#items.pop();
  }
  peek() {
    return this.#items[0]; // BUG: should be the last item.
  }
  get size() {
    return this.#items.length;
  }
}
