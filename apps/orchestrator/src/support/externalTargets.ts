import { isIP } from 'node:net';

export interface ExternalServiceUrlOptions {
  envName: string;
  allowHttp?: boolean;
  allowHttps?: boolean;
  allowLoopback?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<ExternalServiceUrlOptions, 'envName'>> = {
  allowHttp: false,
  allowHttps: true,
  allowLoopback: false,
};

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'metadata.internal',
  'instance-data',
]);

export function normalizeExternalServiceBase(raw: string, options: ExternalServiceUrlOptions): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${options.envName} must not be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${options.envName} must be a valid URL`);
  }

  const resolved = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const protocol = parsed.protocol;
  if (protocol === 'http:') {
    if (!resolved.allowHttp) {
      throw new Error(`${options.envName} must use HTTPS`);
    }
  } else if (protocol === 'https:') {
    if (!resolved.allowHttps) {
      throw new Error(`${options.envName} must not use HTTPS`);
    }
  } else {
    throw new Error(`${options.envName} must use HTTP(S)`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${options.envName} must not include credentials`);
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error(`${options.envName} must include a hostname`);
  }

  if (isMetadataHostname(hostname)) {
    throw new Error(`${options.envName} must not point to metadata service addresses`);
  }

  if (!resolved.allowLoopback && isLoopbackHostname(hostname)) {
    throw new Error(`${options.envName} must not point to loopback addresses`);
  }

  parsed.hash = '';
  if (parsed.search) {
    parsed.search = '';
  }

  return parsed;
}

function isLoopbackHostname(hostname: string): boolean {
  const trimmed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = trimmed.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0') {
    return true;
  }
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    return true;
  }

  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (mapped.startsWith('127.') || mapped === '0.0.0.0') {
      return true;
    }
    const decoded = decodeMappedIpv4(mapped);
    if (decoded && (decoded.startsWith('127.') || decoded === '0.0.0.0')) {
      return true;
    }
  }

  const ipType = isIP(trimmed);
  if (ipType === 4) {
    return trimmed.startsWith('127.') || trimmed === '0.0.0.0';
  }
  if (ipType === 6) {
    const normalized = lower.replace(/^::ffff:/, '');
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return true;
    }
    if (normalized.startsWith('127.')) {
      return true;
    }
    if (normalized === '0.0.0.0') {
      return true;
    }
  }
  return false;
}

function decodeMappedIpv4(hex: string): string | null {
  if (!hex.includes(':')) return null;
  const parts = hex.split(':');
  if (parts.length !== 2) return null;
  const [highHex, lowHex] = parts;
  if (!/^[0-9a-f]{1,4}$/i.test(highHex) || !/^[0-9a-f]{1,4}$/i.test(lowHex)) {
    return null;
  }
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  if (Number.isNaN(high) || Number.isNaN(low)) {
    return null;
  }
  const value = (high << 16) + low;
  const octets = [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  return octets.join('.');
}

function isMetadataHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }

  if (lower.endsWith('.metadata.google.internal')) {
    return true;
  }

  const ipType = isIP(hostname);
  if (ipType === 4) {
    if (hostname.startsWith('169.254.')) {
      return true;
    }
    if (hostname === '100.100.100.200') {
      return true;
    }
  }
  if (ipType === 6) {
    return lower === 'fe80::' || lower.startsWith('fe80::');
  }

  return false;
}
