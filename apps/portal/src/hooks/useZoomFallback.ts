import { useEffect } from 'react';

const ZOOM_DATA_ATTRIBUTE = 'zoom';
const ZOOM_NORMAL = 'normal';
const ZOOM_HIGH = 'high';
const HIGH_ZOOM_THRESHOLD = 1.75;

const resolveZoomScale = (): number => {
  if (typeof window === 'undefined') {
    return 1;
  }
  if (window.visualViewport && typeof window.visualViewport.scale === 'number') {
    return window.visualViewport.scale;
  }
  return window.devicePixelRatio ?? 1;
};

export const useZoomFallback = (): void => {
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;

    const applyZoomClass = () => {
      const scale = resolveZoomScale();
      root.dataset[ZOOM_DATA_ATTRIBUTE] = scale >= HIGH_ZOOM_THRESHOLD ? ZOOM_HIGH : ZOOM_NORMAL;
    };

    applyZoomClass();

    const handleResize = () => {
      applyZoomClass();
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    window.addEventListener('resize', handleResize);

    return () => {
      viewport?.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      window.removeEventListener('resize', handleResize);
      delete root.dataset[ZOOM_DATA_ATTRIBUTE];
    };
  }, []);
};

export default useZoomFallback;
