import { vi } from 'vitest';

export const createMockElement = () => ({
  nodeType: 1,
  ownerDocument: undefined as Document | undefined,
  nodeName: 'DIV',
  tagName: 'DIV',
  namespaceURI: 'http://www.w3.org/1999/xhtml',
  appendChild: vi.fn(),
  removeChild: vi.fn(),
  setAttribute: vi.fn(),
  firstChild: null,
  childNodes: [] as unknown[],
  innerHTML: '',
  textContent: '',
  style: {} as Record<string, unknown>,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

export const createMockDocument = () => {
  const bodyElements: unknown[] = [];
  const body = {
    appendChild: vi.fn((node: unknown) => {
      bodyElements.push(node);
      return node;
    }),
    removeChild: vi.fn((node: unknown) => {
      const index = bodyElements.indexOf(node);
      if (index >= 0) {
        bodyElements.splice(index, 1);
      }
      return node;
    }),
  };
  const doc = {
    nodeType: 9,
    createElement: vi.fn(() => {
      const element = createMockElement();
      element.ownerDocument = doc as unknown as Document;
      return element;
    }),
    createElementNS: vi.fn((_ns: string, tag: string) => {
      const element = createMockElement();
      element.ownerDocument = doc as unknown as Document;
      element.tagName = tag.toUpperCase();
      element.nodeName = element.tagName;
      return element;
    }),
    body,
    documentElement: { lang: 'en' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  return doc;
};

export const installMockDom = (overrides: Partial<Window> = {}) => {
  const localStorage = overrides.localStorage ?? {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const navigator = overrides.navigator ?? { language: 'en-US' };
  const documentRef = overrides.document ?? (globalThis.document as unknown) ?? createMockDocument();

  vi.stubGlobal('document', documentRef);
  vi.stubGlobal('window', {
    localStorage,
    navigator,
    document: documentRef,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...overrides,
  });
  vi.stubGlobal('navigator', navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  return { document: documentRef, window: globalThis.window as Window, localStorage };
};
