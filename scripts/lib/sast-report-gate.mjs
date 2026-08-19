export function validateSastReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("SAST report must be a JSON object.");
  }
  if (!Array.isArray(report.vulnerabilities)) {
    throw new TypeError("SAST report must contain a vulnerabilities array.");
  }
  if (report?.scan?.status !== "success") {
    throw new Error("SAST report must describe a successful scan.");
  }
  if (report.vulnerabilities.length > 0) {
    throw new Error(
      `SAST report contains ${report.vulnerabilities.length} vulnerability finding(s).`,
    );
  }

  return Object.freeze({ total: 0 });
}
