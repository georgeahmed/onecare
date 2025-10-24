const pseudoAccentMap: Record<string, string> = {
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Đ',
  E: 'Ē',
  F: 'Ḟ',
  G: 'Ģ',
  H: 'Ħ',
  I: 'Ĩ',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ń',
  O: 'Ø',
  P: 'Ṗ',
  Q: 'Ǫ',
  R: 'Ŗ',
  S: 'Ŝ',
  T: 'Ť',
  U: 'Ū',
  V: 'Ṿ',
  W: 'Ŵ',
  X: 'Ẍ',
  Y: 'Ŷ',
  Z: 'Ż',
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'đ',
  e: 'ē',
  f: 'ƒ',
  g: 'ģ',
  h: 'ħ',
  i: 'ĩ',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ṁ',
  n: 'ń',
  o: 'ø',
  p: 'ṗ',
  q: 'ǫ',
  r: 'ŗ',
  s: 'ŝ',
  t: 'ť',
  u: 'ū',
  v: 'ṿ',
  w: 'ŵ',
  x: 'ẍ',
  y: 'ŷ',
  z: 'ż'
};

export const createPseudoMessage = (value: string): string => {
  const segments = value.split(/(\{[^}]+\})/g);
  const transformed = segments.map((segment) => {
    if (segment.startsWith('{') && segment.endsWith('}')) {
      return segment;
    }
    return segment
      .split('')
      .map((char) => pseudoAccentMap[char] ?? char)
      .join('');
  });
  return `⟦${transformed.join('')}⟧`;
};

export const generatePseudoMessages = (base: Record<string, string>): Record<string, string> => {
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, createPseudoMessage(value)]));
};

