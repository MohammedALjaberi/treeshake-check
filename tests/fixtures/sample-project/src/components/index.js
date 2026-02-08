// Test fixture with intentional tree-shaking issues

// Issue 1: Barrel file with wildcard exports
export * from "./button";
export * from "./input";
export * from "./modal";

// Issue 2: Side effect - top level console.log
console.log("Loading UI components...");

// Issue 3: Global assignment
window.UILibraryVersion = "1.0.0";

// Issue 4: CommonJS require mixed with ESM
const lodash = require("lodash");

// Unused export
export const UNUSED_CONSTANT = "never-imported";

// Good: Named export (tree-shakeable)
export const Button = () => "<button/>";
export const Input = () => "<input/>";
