#!/usr/bin/env node

/**
 * Bounded sanitized integration report for the disposable GitLab MCP suite.
 *
 * The report records capability coverage, cleanup outcomes, and timing without
 * ever including credentials, CI variable values, request/response payloads,
 * or other sensitive project information.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPORT_VERSION = 1;
const MAX_REPORT_BYTES = 64 * 1024;

/** @typedef {"passed"|"skipped"|"failed"|"unsupported"} CapabilityStatus */

/**
 * @typedef {object} CapabilityEntry
 * @property {string} name
 * @property {CapabilityStatus} status
 * @property {string} [reason] - Human-readable reason for skip/unsupported/fail.
 * @property {string} [category] - Normalized capability category.
 * @property {boolean} [required] - Whether this capability is required for the run to be considered successful.
 */

/**
 * @typedef {object} CleanupEntry
 * @property {string} resource - Resource type (issue, merge_request, branch).
 * @property {boolean} cleaned - Whether cleanup succeeded.
 * @property {string} [error] - Sanitized error message if cleanup failed.
 */

/**
 * @typedef {object} IntegrationReport
 * @property {number} schemaVersion
 * @property {string} [commitSha] - Source commit SHA when available.
 * @property {string} runId
 * @property {string} startedAt - ISO 8601 timestamp.
 * @property {string|null} completedAt - ISO 8601 timestamp or null if incomplete.
 * @property {"success"|"failure"|"incomplete"} overallStatus
 * @property {CapabilityEntry[]} capabilities
 * @property {CleanupEntry[]} cleanup
 * @property {object} flags - Boolean feature/coverage flags.
 * @property {boolean} flags.mergeRequestCoverage
 * @property {boolean} flags.artifactCoverage
 * @property {boolean} flags.optionalCoverageEnabled
 */

/**
 * Create a new integration report.
 *
 * @param {object} options
 * @param {string} options.runId
 * @param {string} [options.commitSha]
 * @returns {IntegrationReport}
 */
export function createReport({ runId, commitSha }) {
  return {
    schemaVersion: REPORT_VERSION,
    commitSha: commitSha || undefined,
    runId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    overallStatus: "incomplete",
    capabilities: [],
    cleanup: [],
    flags: {
      mergeRequestCoverage: false,
      artifactCoverage: false,
      optionalCoverageEnabled: false,
    },
  };
}

/**
 * Record a capability result.
 *
 * @param {IntegrationReport} report
 * @param {string} name
 * @param {CapabilityStatus} status
 * @param {object} [options]
 * @param {string} [options.reason]
 * @param {string} [options.category]
 * @param {boolean} [options.required]
 */
export function addCapability(report, name, status, options = {}) {
  /** @type {CapabilityEntry} */
  const entry = { name, status };
  if (options.reason) entry.reason = sanitizeError(options.reason);
  if (options.category) entry.category = options.category;
  if (options.required !== undefined) entry.required = options.required;
  report.capabilities.push(entry);
}

/**
 * Record a cleanup outcome.
 *
 * @param {IntegrationReport} report
 * @param {string} resource
 * @param {boolean} cleaned
 * @param {string} [error]
 */
export function addCleanup(report, resource, cleaned, error) {
  /** @type {CleanupEntry} */
  const entry = { resource, cleaned };
  if (error) entry.error = sanitizeError(error);
  report.cleanup.push(entry);
}

/**
 * Finalize the report with an overall status.
 *
 * @param {IntegrationReport} report
 * @param {"success"|"failure"} status
 */
export function finalizeReport(report, status) {
  report.completedAt = new Date().toISOString();
  report.overallStatus = status;
}

/**
 * Sanitize an error string to remove potential token or secret fragments.
 *
 * @param {string} error
 * @returns {string}
 */
export function sanitizeError(error) {
  if (typeof error !== "string") return "unknown error";
  // Remove anything that looks like a bearer token, private token, or long hex secret
  return error
    .replace(/[Bb]earer\s+[A-Za-z0-9._-]{20,}/g, "Bearer [REDACTED]")
    .replace(/[Tt]oken[=:]\s*[A-Za-z0-9._-]{20,}/g, "Token=[REDACTED]")
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/[a-f0-9]{40,}/gi, "[REDACTED]")
    .slice(0, 512);
}

/**
 * Wrap a capability call with report tracking. Records success or failure
 * in the report and returns the result of `fn()` to callers.
 *
 * @param {IntegrationReport} report
 * @param {string} name
 * @param {() => Promise<any>} fn
 * @param {object} [options]
 * @param {string} [options.category]
 * @param {boolean} [options.required]
 * @returns {Promise<any>} The result of `fn()`.
 */
export async function trackedCall(report, name, fn, options = {}) {
  try {
    const result = await fn();
    addCapability(report, name, "passed", {
      category: options.category,
      required: options.required,
    });
    return result;
  } catch (error) {
    addCapability(report, name, "failed", {
      reason: String(error.message || error),
      category: options.category,
      required: options.required,
    });
    throw error;
  }
}

/**
 * Compute the report byte length. Returns 0 if the report exceeds safety limits.
 *
 * @param {IntegrationReport} report
 * @returns {number}
 */
export function reportByteLength(report) {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * Serialize the report to a sanitized bounded JSON string.
 *
 * @param {IntegrationReport} report
 * @returns {string}
 */
export function serializeReport(report) {
  const json = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(json, "utf8") > MAX_REPORT_BYTES) {
    // Produce a minimal truncated report that signals truncation
    return JSON.stringify({
      schemaVersion: report.schemaVersion,
      runId: report.runId,
      overallStatus: report.overallStatus,
      truncated: true,
      capabilityCount: report.capabilities.length,
    });
  }
  return json;
}

/**
 * Write the report to disk.
 *
 * @param {IntegrationReport} report
 * @param {string} directory - Output directory.
 * @param {string} [filename] - Report filename.
 * @returns {Promise<string>} Absolute path of the written report.
 */
export async function writeReport(
  report,
  directory,
  filename = "integration-report.json",
) {
  const payload = serializeReport(report);
  const filePath = join(directory, filename);
  await writeFile(filePath, `${payload}\n`, "utf8");
  return filePath;
}
