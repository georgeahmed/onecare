export const classNames = (...tokens: Array<string | false | null | undefined>): string =>
  tokens.filter(Boolean).join(' ');
