import { readFileSync, existsSync } from "fs";
import { glob } from "glob";
import { join, relative } from "path";
import type {
  AnalysisConfig,
  AnalysisReport,
  AnalysisSummary,
  TreeShakingIssue,
  BundlerType,
} from "../types/index.js";
import {
  detectBundler,
  getDefaultStatsPath,
  getBundlerFilePatterns,
} from "../bundlers/detector.js";
import { analyzeBarrelFiles } from "../analyzers/barrel.js";
import {
  analyzeSideEffects,
  checkSideEffectsConfig,
} from "../analyzers/side-effects.js";
import { analyzeModuleTypes } from "../analyzers/module-type.js";
import { analyzeUnusedExports } from "../analyzers/exports.js";
import { parseWebpackStats } from "../bundlers/webpack.js";
import { parseEsbuildMetafile } from "../bundlers/esbuild.js";
import { parseViteStats } from "../bundlers/vite.js";

/**
 * Main entry point for analyzing a project
 */
export async function analyzeProject(
  config: AnalysisConfig,
): Promise<AnalysisReport> {
  const { projectPath, outputFormat, threshold, showSuggestions } = config;

  // Detect bundler if not specified
  const bundler: BundlerType = config.bundler || detectBundler(projectPath);

  // Find stats file if not specified
  let statsFile = config.statsFile;
  if (!statsFile) {
    statsFile = getDefaultStatsPath(projectPath, bundler) || undefined;
  }

  // Get files to analyze
  const filePatterns = getBundlerFilePatterns(bundler);
  const excludePatterns = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    ...(config.exclude || []),
  ];

  const files = await glob(filePatterns, {
    cwd: projectPath,
    ignore: excludePatterns,
    absolute: true,
  });

  // Collect all issues
  const issues: TreeShakingIssue[] = [];

  // Run source code analyzers
  const barrelIssues = await analyzeBarrelFiles(files, projectPath);
  issues.push(...barrelIssues);

  const sideEffectIssues = await analyzeSideEffects(files, projectPath);
  issues.push(...sideEffectIssues);

  const configIssues = await checkSideEffectsConfig(projectPath);
  issues.push(...configIssues);

  const moduleTypeIssues = await analyzeModuleTypes(files, projectPath);
  issues.push(...moduleTypeIssues);

  const unusedExportIssues = await analyzeUnusedExports(files, projectPath);
  issues.push(...unusedExportIssues);

  // Analyze bundle stats if available
  if (statsFile && existsSync(statsFile)) {
    const bundleIssues = await analyzeBundleStats(statsFile, bundler);
    issues.push(...bundleIssues);
  }

  // Filter by threshold
  const filteredIssues = issues.filter(
    (issue) => issue.estimatedImpact >= threshold,
  );

  // Sort by impact (highest first)
  filteredIssues.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.estimatedImpact - a.estimatedImpact;
  });

  // Build summary
  const summary: AnalysisSummary = {
    projectPath,
    bundler,
    totalIssues: filteredIssues.length,
    criticalCount: filteredIssues.filter((i) => i.severity === "critical")
      .length,
    highCount: filteredIssues.filter((i) => i.severity === "high").length,
    mediumCount: filteredIssues.filter((i) => i.severity === "medium").length,
    lowCount: filteredIssues.filter((i) => i.severity === "low").length,
    estimatedSavings: filteredIssues.reduce(
      (sum, i) => sum + i.estimatedImpact,
      0,
    ),
    analyzedFiles: files.length,
    timestamp: new Date().toISOString(),
  };

  // Remove suggestions if not requested
  const reportIssues = showSuggestions
    ? filteredIssues
    : filteredIssues.map(
        ({ suggestion, ...issue }) => issue as TreeShakingIssue,
      );

  return {
    summary,
    issues: reportIssues,
  };
}

/**
 * Analyze bundle stats file for additional insights
 */
async function analyzeBundleStats(
  statsFile: string,
  bundler: BundlerType,
): Promise<TreeShakingIssue[]> {
  try {
    const content = readFileSync(statsFile, "utf-8");
    const stats = JSON.parse(content);

    switch (bundler) {
      case "webpack":
        return parseWebpackStats(stats);
      case "esbuild":
        return parseEsbuildMetafile(stats);
      case "vite":
      case "rollup":
        return parseViteStats(stats);
      default:
        return [];
    }
  } catch {
    // Ignore stats parsing errors
    return [];
  }
}
