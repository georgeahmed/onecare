#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith('--')) {
    throw new Error(`Invalid argument: ${key} ${value ?? ''}`);
  }
  options[key.slice(2)] = value;
}

function readJson(path, optional = false) {
  if (!path) {
    if (optional) return null;
    throw new Error('Missing required path');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (optional) return null;
    throw new Error(`Failed to read JSON from ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const severityWeights = new Map([
  ['none', 0],
  ['info', 0],
  ['low', 1],
  ['medium', 2],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

function toSeverityValue(severity) {
  if (!severity) return -1;
  const normalized = String(severity).toLowerCase();
  return severityWeights.get(normalized) ?? -1;
}

function meetsThreshold(severity, threshold) {
  return toSeverityValue(severity) >= toSeverityValue(threshold);
}

const policy = readJson(options.policy ?? 'config/security/vuln-policy.json');
const licensePolicy = readJson(options['license-policy'] ?? 'config/security/license-policy.json');

const allowlist = Array.isArray(policy.allowlist) ? policy.allowlist : [];
const severityThreshold = policy.severityThreshold ?? 'high';
const now = new Date();

function isAllowed(source, pkg, id) {
  return allowlist.some((entry) => {
    if ((entry.source ?? '').toLowerCase() !== source.toLowerCase()) return false;
    if (entry.package && entry.package !== pkg) return false;
    if (entry.id && entry.id !== id) return false;
    if (entry.expires) {
      const expiry = new Date(entry.expires);
      if (Number.isNaN(expiry.valueOf()) || expiry < now) {
        return false;
      }
    }
    return true;
  });
}

const violations = [];

function addViolation(type, details) {
  violations.push({ type, ...details });
}

function collectNpmFindings(path) {
  const data = readJson(path, true);
  if (!data) return;
  const vulnerabilities = Object.values(data.vulnerabilities ?? {});
  for (const vuln of vulnerabilities) {
    const severity = vuln.severity ?? 'info';
    if (!meetsThreshold(severity, severityThreshold)) continue;
    const pkg = vuln.name ?? vuln.package ?? vuln.module_name ?? 'unknown';
    const viaEntries = Array.isArray(vuln.via) ? vuln.via : [];
    const identifiers = new Set();
    for (const via of viaEntries) {
      if (typeof via === 'string') {
        identifiers.add(via);
      } else if (via && typeof via === 'object') {
        if (via.id) identifiers.add(String(via.id));
        if (via.source) identifiers.add(String(via.source));
        if (via.url) identifiers.add(via.url);
        if (via.title) identifiers.add(via.title);
      }
    }
    if (identifiers.size === 0) {
      if (vuln.id) identifiers.add(String(vuln.id));
      else identifiers.add(pkg);
    }
    const allowed = [...identifiers].some((id) => isAllowed('npm', pkg, id));
    if (!allowed) {
      addViolation('npm', {
        package: pkg,
        severity,
        identifiers: [...identifiers],
      });
    }
  }
}

function collectPipFindings(path) {
  const data = readJson(path, true);
  if (!data) return;
  const entries = Array.isArray(data)
    ? data
    : Array.isArray(data.vulnerabilities)
      ? data.vulnerabilities
      : Array.isArray(data.dependencies)
        ? data.dependencies.flatMap((dep) => dep.vulns ?? dep.vulnerabilities ?? [])
        : [];
  for (const vuln of entries) {
    const severity = vuln.severity ?? vuln.cvss?.severity ?? 'info';
    if (!meetsThreshold(severity, severityThreshold)) continue;
    const pkg = vuln.name ?? vuln.dependency?.name ?? 'unknown';
    const identifiers = new Set();
    if (vuln.id) identifiers.add(String(vuln.id));
    if (Array.isArray(vuln.aliases)) {
      for (const alias of vuln.aliases) identifiers.add(String(alias));
    }
    if (identifiers.size === 0) identifiers.add(pkg);
    const allowed = [...identifiers].some((id) => isAllowed('pip', pkg, id));
    if (!allowed) {
      addViolation('pip', {
        package: pkg,
        severity,
        identifiers: [...identifiers],
      });
    }
  }
}

function collectTrivyFindings(path) {
  const data = readJson(path, true);
  if (!data) return;
  const results = Array.isArray(data.Results) ? data.Results : [];
  for (const result of results) {
    const vulns = Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : [];
    for (const vuln of vulns) {
      const severity = vuln.Severity ?? 'info';
      if (!meetsThreshold(severity, severityThreshold)) continue;
      const pkg = vuln.PkgName ?? 'unknown';
      const id = vuln.VulnerabilityID ?? `${pkg}:${vuln.InstalledVersion ?? 'unknown'}`;
      if (!isAllowed('trivy', pkg, id)) {
        addViolation('trivy', {
          package: pkg,
          severity,
          identifiers: [id],
          target: result.Target,
        });
      }
    }
  }
}

function collectLicenseFindings(path) {
  const report = readJson(path, true);
  if (!report) return;
  const allowed = new Set(Array.isArray(licensePolicy.allowedLicenses) ? licensePolicy.allowedLicenses : []);
  const exceptions = Array.isArray(licensePolicy.exceptions) ? licensePolicy.exceptions : [];
  const exceptionMatches = (pkg, license) => {
    return exceptions.some((entry) => {
      if (entry.package && entry.package !== pkg) return false;
      if (entry.license && entry.license !== license) return false;
      if (entry.expires) {
        const expiry = new Date(entry.expires);
        if (Number.isNaN(expiry.valueOf()) || expiry < now) {
          return false;
        }
      }
      return true;
    });
  };

  for (const [pkg, meta] of Object.entries(report)) {
    const license = meta.licenses ?? 'UNKNOWN';
    const normalized = String(license)
      .split(/[\s]*[|/&][\s]*/g)
      .flatMap((fragment) => fragment.split(/\s+OR\s+|\s+AND\s+/i))
      .map((fragment) => fragment.trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      normalized.push('UNKNOWN');
    }
    const disallowed = normalized.filter((name) => !allowed.has(name));
    if (disallowed.length > 0 && !exceptionMatches(pkg, license)) {
      addViolation('license', {
        package: pkg,
        license,
        disallowed,
      });
    }
  }
}

collectNpmFindings(options.npm ?? 'npm-audit.json');
collectPipFindings(options.pip ?? 'pip-audit.json');
collectTrivyFindings(options.trivy ?? 'trivy-results.json');
collectLicenseFindings(options.license ?? 'license-report.json');

if (violations.length > 0) {
  console.error('❌ Security policy violations detected:\n');
  for (const violation of violations) {
    switch (violation.type) {
      case 'npm':
      case 'pip':
      case 'trivy':
        console.error(
          ` - [${violation.type.toUpperCase()}] ${violation.package} (${violation.severity}) identifiers=${violation.identifiers.join(
            ', ',
          )}${violation.target ? ` target=${violation.target}` : ''}`,
        );
        break;
      case 'license':
        console.error(
          ` - [LICENSE] ${violation.package} uses disallowed license(s): ${violation.disallowed.join(', ')} (raw="${violation.license}")`,
        );
        break;
      default:
        console.error(` - [${violation.type}] ${JSON.stringify(violation)}`);
    }
  }
  exit(1);
}

console.log('✅ Security scans passed policy checks');
