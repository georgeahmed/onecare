import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const getInitialOfflineState = (): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
    return false;
  }
  return !navigator.onLine;
};

const OfflineNotice = () => {
  const intl = useIntl();
  const [isOffline, setIsOffline] = useState<boolean>(getInitialOfflineState);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) {
    return null;
  }

  return (
    <div className="app-offline-notice" role="status" aria-live="polite">
      <p>{intl.formatMessage({ id: 'app.offlineIndicator' })}</p>
    </div>
  );
};

export default OfflineNotice;
