# treeshake-check

A production-grade CLI tool to analyze JavaScript/TypeScript React applications for tree-shaking issues.

## Features

- 🔍 **Auto-detect bundlers** - Vite, Webpack, Rollup, esbuild
- 🌳 **Barrel file analysis** - Detect `export *` patterns that break tree-shaking
- ⚠️ **Side effects detection** - Find top-level code that prevents dead code elimination
- 📦 **CommonJS detection** - Identify modules that don't tree-shake
- 📊 **Bundle stats parsing** - Analyze webpack stats.json, esbuild metafile, Vite/Rollup output
- 💡 **Fix suggestions** - Actionable recommendations for each issue
- 📋 **Multiple output formats** - Human-readable text or JSON for CI

## Installation

```bash
npm install -g treeshake-check

# Or use directly with npx
npx treeshake-check analyze
```

## Usage

### Analyze a project

```bash
# Analyze current directory (auto-detect bundler)
treeshake-check analyze

# Analyze a specific directory
treeshake-check analyze ./my-react-app

# With specific bundler stats
treeshake-check analyze --stats dist/stats.json
```

### CLI Options

```bash
treeshake-check analyze [path] [options]

Options:
  -b, --bundler <type>       Force bundler type (vite|webpack|rollup|esbuild)
  -s, --stats <file>         Path to bundle stats/metafile
  -o, --output <format>      Output format (text|json) (default: "text")
  -t, --threshold <bytes>    Minimum size to report (default: "0")
  --no-suggestions           Hide fix suggestions
  -i, --include <patterns>   Glob patterns to include
  -e, --exclude <patterns>   Glob patterns to exclude
```

### Generate bundle stats

#### Webpack

```bash
webpack --json > stats.json
treeshake-check analyze --stats stats.json
```

#### Vite/Rollup

```bash
# Install rollup-plugin-visualizer
npm install -D rollup-plugin-visualizer

# Configure in vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    visualizer({ filename: 'stats.json', json: true })
  ]
});
```

#### esbuild

```javascript
// Enable metafile in build
await esbuild
  .build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    metafile: true,
    outfile: "dist/bundle.js",
  })
  .then((result) => {
    fs.writeFileSync("meta.json", JSON.stringify(result.metafile));
  });
```

## Example Output

```
🔍 Tree-Shaking Analysis Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Summary:
  📁 Project: /path/to/project
  🔧 Bundler: vite
  📊 Files Analyzed: 42

  ⚠️  Issues Found: 5
     ● Critical: 1
     ● High: 2
     ● Medium: 2
  📦 Potential Savings: 85.3 KB

CRITICAL ISSUES
────────────────
1. CommonJS Module: node_modules/lodash/index.js
   └─ Pattern: require('lodash')
   └─ Impact: 72 KB
   └─ lodash CommonJS bundle is included. Use lodash-es for tree-shaking.
   └─ Fix: Switch to lodash-es
      import { debounce } from 'lodash-es'

HIGH PRIORITY ISSUES
────────────────────
2. Wildcard Re-export: src/components/index.ts
   └─ Line: 5
   └─ Pattern: export * from './Button'
   └─ Impact: 8.2 KB
   └─ Wildcard re-export prevents tree-shaking.
   └─ Fix: Use explicit named exports
      export { Button } from './Button'
```

## JSON Output

Use `--output json` for CI integration:

```json
{
  "summary": {
    "projectPath": "/path/to/project",
    "bundler": "vite",
    "totalIssues": 5,
    "criticalCount": 1,
    "highCount": 2,
    "mediumCount": 2,
    "lowCount": 0,
    "estimatedSavings": 87347,
    "analyzedFiles": 42
  },
  "issues": [
    {
      "type": "commonjs-module",
      "severity": "critical",
      "file": "node_modules/lodash/index.js",
      "pattern": "require('lodash')",
      "estimatedImpact": 72000,
      "suggestion": {
        "title": "Switch to lodash-es",
        "code": "import { debounce } from 'lodash-es'"
      }
    }
  ]
}
```

## Issue Types

| Type                         | Description                                  |
| ---------------------------- | -------------------------------------------- |
| `barrel-file`                | Barrel files with many re-exports            |
| `wildcard-reexport`          | `export *` patterns that include all exports |
| `side-effect`                | Top-level code that runs on import           |
| `commonjs-module`            | CommonJS modules that don't tree-shake       |
| `unused-export`              | Exports not imported anywhere                |
| `missing-sideeffects-config` | Missing `sideEffects` in package.json        |

## License

MIT
