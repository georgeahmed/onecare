const OR_OPERATORS = [
  { pattern: ' OR ', boundary: false },
  { pattern: '||', boundary: false },
  { pattern: '|', boundary: false },
  { pattern: ',', boundary: false },
  { pattern: '/', boundary: false },
];

const AND_OPERATORS = [
  { pattern: ' AND ', boundary: false },
  { pattern: '&&', boundary: false },
  { pattern: '&', boundary: false },
];

const PAREN_OPEN = '(';
const PAREN_CLOSE = ')';

const WHITESPACE_OR_PAREN = /^[\s()]*$/;

function flattenLicenseExpressions(expressions) {
  if (Array.isArray(expressions)) {
    return expressions.flatMap((expr) => flattenLicenseExpressions(expr));
  }
  if (typeof expressions === 'string') {
    const trimmed = expressions.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (expressions && typeof expressions === 'object') {
    const collected = new Set();
    const candidateFields = ['type', 'license', 'name', 'expression'];
    for (const field of candidateFields) {
      const value = expressions[field];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          collected.add(trimmed);
        }
      }
    }
    if (Array.isArray(expressions.licenses)) {
      for (const nested of flattenLicenseExpressions(expressions.licenses)) {
        collected.add(nested);
      }
    }
    return Array.from(collected);
  }
  return [];
}

export function normaliseAllowedLicenses(licenses = []) {
  const normalised = new Set();
  for (const license of licenses) {
    for (const token of normaliseLicenseName(license)) {
      normalised.add(token);
    }
  }
  return normalised;
}

export function evaluateLicenseExpressions(expressions, allowedSet) {
  const cleanedExpressions = flattenLicenseExpressions(expressions);
  if (cleanedExpressions.length === 0) {
    cleanedExpressions.push('UNKNOWN');
  }

  const allowed = cleanedExpressions.some((expr) => isLicenseExpressionAllowed(expr, allowedSet));
  if (allowed) {
    return { allowed: true, disallowed: [] };
  }

  const disallowedTokens = new Set();
  for (const expr of cleanedExpressions) {
    const tokens = extractLicenseTokens(expr);
    for (const token of tokens) {
      if (!isLicenseIdAllowed(token, allowedSet)) {
        disallowedTokens.add(token);
      }
    }
  }

  if (disallowedTokens.size === 0) {
    for (const expr of cleanedExpressions) {
      extractLicenseTokens(expr).forEach((token) => disallowedTokens.add(token));
    }
  }

  return { allowed: false, disallowed: Array.from(disallowedTokens) };
}

export function isLicenseExpressionAllowed(expression, allowedSet) {
  if (!expression || typeof expression !== 'string') {
    return false;
  }
  let working = expression.trim();
  if (!working) return false;
  working = stripOuterParens(working);

  const orOperator = findTopLevelOperator(working, OR_OPERATORS);
  if (orOperator) {
    const left = working.slice(0, orOperator.index);
    const right = working.slice(orOperator.index + orOperator.length);
    if (isLicenseExpressionAllowed(left, allowedSet)) return true;
    return isLicenseExpressionAllowed(right, allowedSet);
  }

  const andOperator = findTopLevelOperator(working, AND_OPERATORS);
  if (andOperator) {
    const left = working.slice(0, andOperator.index);
    const right = working.slice(andOperator.index + andOperator.length);
    return (
      isLicenseExpressionAllowed(left, allowedSet) &&
      isLicenseExpressionAllowed(right, allowedSet)
    );
  }

  return isLicenseIdAllowed(working, allowedSet);
}

export function extractLicenseTokens(expression) {
  if (!expression || typeof expression !== 'string') return [];
  let working = expression.trim();
  if (!working) return [];
  working = stripOuterParens(working);

  const orOperator = findTopLevelOperator(working, OR_OPERATORS);
  if (orOperator) {
    const left = working.slice(0, orOperator.index);
    const right = working.slice(orOperator.index + orOperator.length);
    return [...extractLicenseTokens(left), ...extractLicenseTokens(right)];
  }

  const andOperator = findTopLevelOperator(working, AND_OPERATORS);
  if (andOperator) {
    const left = working.slice(0, andOperator.index);
    const right = working.slice(andOperator.index + andOperator.length);
    return [...extractLicenseTokens(left), ...extractLicenseTokens(right)];
  }

  const base = extractBaseLicenseId(working);
  return base ? [base] : [];
}

function isLicenseIdAllowed(id, allowedSet) {
  const base = extractBaseLicenseId(id);
  if (!base) return false;
  for (const candidate of normaliseLicenseName(base)) {
    if (allowedSet.has(candidate)) {
      return true;
    }
  }
  return false;
}

function extractBaseLicenseId(expression) {
  if (!expression) return undefined;
  let base = expression.trim();
  const withIdx = base.toUpperCase().indexOf(' WITH ');
  if (withIdx >= 0) {
    base = base.slice(0, withIdx);
  }
  base = base.replace(/[()]/g, '').replace(/\*+$/, '').trim();
  if (!base) return undefined;
  return base;
}

function stripOuterParens(expression) {
  let working = expression.trim();
  while (working.startsWith(PAREN_OPEN) && working.endsWith(PAREN_CLOSE)) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < working.length; index += 1) {
      const char = working[index];
      if (char === PAREN_OPEN) depth += 1;
      else if (char === PAREN_CLOSE) {
        depth -= 1;
        if (depth < 0) {
          balanced = false;
          break;
        }
        if (depth === 0 && index !== working.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced || depth !== 0) {
      break;
    }
    working = working.slice(1, -1).trim();
  }
  return working;
}

function findTopLevelOperator(expression, operators) {
  const upper = expression.toUpperCase();
  let depth = 0;

  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    if (char === PAREN_OPEN) {
      depth += 1;
      continue;
    }
    if (char === PAREN_CLOSE) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;

    for (const operator of operators) {
      if (!upper.startsWith(operator.pattern, index)) {
        continue;
      }
      if (operator.boundary && !operatorHasBoundaries(upper, index, operator.pattern.length)) {
        continue;
      }
      return { index, length: operator.pattern.length };
    }
  }
  return null;
}

function operatorHasBoundaries(source, index, length) {
  const before = index === 0 ? '' : source[index - 1];
  const after = index + length >= source.length ? '' : source[index + length];
  const beforeOk = before === '' || WHITESPACE_OR_PAREN.test(before);
  const afterOk = after === '' || WHITESPACE_OR_PAREN.test(after);
  return beforeOk && afterOk;
}

function normaliseLicenseName(name) {
  if (!name || typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const stripped = trimmed.replace(/[()]/g, '').replace(/\*+$/, '').trim();
  if (!stripped) return [];
  const singleSpaced = stripped.replace(/\s+/g, ' ');
  const withoutDecorators = singleSpaced
    .replace(/\b(?:licen[cs]e|version)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutDecorators) return [];
  const lower = withoutDecorators.toLowerCase();
  const hyphenated = lower.replace(/\s+/g, '-');
  const variants = new Set([lower, hyphenated]);
  return Array.from(variants);
}

export function exceptionMatches(entry, pkg, licenseLabel) {
  if (!Array.isArray(entry)) return false;
  const now = new Date();
  const labelCandidates = buildLicenseCandidateSet(licenseLabel);

  return entry.some((exception) => {
    if (exception.package && exception.package !== pkg) return false;
    if (exception.expires) {
      const expiry = new Date(exception.expires);
      if (Number.isNaN(expiry.valueOf()) || expiry < now) return false;
    }
    if (!exception.license) {
      return true;
    }
    const exceptionCandidates = buildLicenseCandidateSet(exception.license);
    if (exceptionCandidates.size === 0) {
      return true;
    }
    for (const candidate of exceptionCandidates) {
      if (labelCandidates.has(candidate)) {
        return true;
      }
    }
    return false;
  });
}

function buildLicenseCandidateSet(label) {
  const candidates = new Set();
  for (const expr of flattenLicenseExpressions(label ?? [])) {
    const normalizedExpr = expr.trim().toLowerCase();
    if (normalizedExpr) {
      candidates.add(normalizedExpr);
    }
    for (const token of extractLicenseTokens(expr)) {
      const normalizedToken = token.trim().toLowerCase();
      if (normalizedToken) {
        candidates.add(normalizedToken);
      }
    }
  }
  return candidates;
}

export { flattenLicenseExpressions };
