import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BundlerType } from "../types/index.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/**
 * Auto-detect the bundler used in a project by examining config files and package.json
 */
export function detectBundler(projectPath: string): BundlerType {
  // Check for config files first (most reliable)
  const configChecks: Array<{ files: string[]; bundler: BundlerType }> = [
    {
      files: [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mts",
        "vite.config.mjs",
      ],
      bundler: "vite",
    },
    {
      files: ["webpack.config.js", "webpack.config.ts", "webpack.config.mjs"],
      bundler: "webpack",
    },
    {
      files: ["rollup.config.js", "rollup.config.ts", "rollup.config.mjs"],
      bundler: "rollup",
    },
    {
      files: ["esbuild.config.js", "esbuild.config.ts", "esbuild.config.mjs"],
      bundler: "esbuild",
    },
  ];

  for (const check of configChecks) {
    for (const file of check.files) {
      if (existsSync(join(projectPath, file))) {
        return check.bundler;
      }
    }
  }

  // Check package.json for dependencies and scripts
  const packageJsonPath = join(projectPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson: PackageJson = JSON.parse(
        readFileSync(packageJsonPath, "utf-8"),
      );
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Check dependencies
      if (allDeps["vite"]) return "vite";
      if (allDeps["webpack"]) return "webpack";
      if (allDeps["rollup"]) return "rollup";
      if (allDeps["esbuild"]) return "esbuild";

      // Check scripts for bundler commands
      const scripts = Object.values(packageJson.scripts || {}).join(" ");
      if (scripts.includes("vite")) return "vite";
      if (scripts.includes("webpack")) return "webpack";
      if (scripts.includes("rollup")) return "rollup";
      if (scripts.includes("esbuild")) return "esbuild";
    } catch {
      // Ignore JSON parse errors
    }
  }

  return "unknown";
}

/**
 * Get the default stats file path for a bundler
 */
export function getDefaultStatsPath(
  projectPath: string,
  bundler: BundlerType,
): string | null {
  const statsLocations: Record<BundlerType, string[]> = {
    vite: ["dist/.vite/stats.json", "dist/stats.json", ".vite/stats.json"],
    webpack: ["dist/stats.json", "build/stats.json", "stats.json"],
    rollup: ["dist/stats.json", "stats.json"],
    esbuild: ["dist/meta.json", "meta.json", "metafile.json"],
    unknown: [],
  };

  const locations = statsLocations[bundler];
  for (const location of locations) {
    const fullPath = join(projectPath, location);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Get bundler-specific file extensions to analyze
 */
export function getBundlerFilePatterns(bundler: BundlerType): string[] {
  // All modern bundlers handle these file types
  return ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.mts"];
}
