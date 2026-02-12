// Circular dependency test: a.js imports from b.js
import { helperB } from "./b.js";

export function helperA() {
  return "A:" + helperB();
}
