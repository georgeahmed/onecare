import { useIntl } from 'react-intl';
import { getLocaleMetadata, useLocale } from '../i18n';

const LocaleNotice = () => {
  const { locale, status, refreshLocale, hasLocaleUpdate } = useLocale();
  const intl = useIntl();
  const { labelId } = getLocaleMetadata(locale);
  const localeName = intl.formatMessage({ id: labelId, defaultMessage: locale.toUpperCase() });

  if (status === 'fallback') {
    return (
      <div className="app-locale-notice app-locale-notice--warning" role="status" aria-live="polite">
        <p>
          {intl.formatMessage(
            { id: 'app.localeFallback.notice' },
            { localeName }
          )}
        </p>
        <div className="app-locale-notice__actions">
          <button type="button" className="ui-button ui-button--subtle" onClick={refreshLocale}>
            {intl.formatMessage({ id: 'app.localeFallback.retry' })}
          </button>
          <button
            type="button"
            className="ui-button ui-button--subtle"
            onClick={() => window.location.reload()}
          >
            {intl.formatMessage({ id: 'app.localeFallback.refresh' })}
          </button>
        </div>
      </div>
    );
  }

  if (hasLocaleUpdate) {
    return (
      <div className="app-locale-notice" role="status" aria-live="polite">
        <p>{intl.formatMessage({ id: 'app.localeUpdated.notice' })}</p>
        <div className="app-locale-notice__actions">
          <button
            type="button"
            className="ui-button ui-button--subtle"
            onClick={() => window.location.reload()}
          >
            {intl.formatMessage({ id: 'app.localeUpdated.refresh' })}
          </button>
        </div>
      </div>
    );
  }

  return null;
};

export default LocaleNotice;
