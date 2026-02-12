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

// Issue 5: Problematic ESM imports (default import of non-tree-shakeable lib)
import moment from "moment";

// Issue 6: Namespace import of large library
import * as Icons from "@mui/icons-material";

// Issue 7: Bare side-effect import
import "./polyfills";

// Issue 8: Non-static dynamic import
const page = "home";
const mod = import(page);

// Unused export
export const UNUSED_CONSTANT = "never-imported";

// Good: Named export (tree-shakeable)
export const Button = () => "<button/>";
export const Input = () => "<input/>";
