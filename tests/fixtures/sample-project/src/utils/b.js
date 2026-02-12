// Circular dependency test: b.js imports from a.js
import { helperA } from "./a.js";

export function helperB() {
  return "B:" + helperA();
}
