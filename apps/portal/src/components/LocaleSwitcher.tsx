import { ChangeEvent, useMemo, useId } from 'react';
import { useIntl } from 'react-intl';
import { getAvailableLocales, getLocaleMetadata, type Locale, useLocale } from '../i18n';

const LocaleSwitcher = () => {
  const { locale, setLocale } = useLocale();
  const intl = useIntl();
  const selectId = useId();
  const availableLocales = useMemo(() => getAvailableLocales(), []);

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = event.target.value as Locale;
    if (nextLocale === locale) return;
    if (availableLocales.includes(nextLocale)) {
      setLocale(nextLocale);
    }
  };

  return (
    <div className="locale-switcher">
      <label htmlFor={selectId}>{intl.formatMessage({ id: 'app.localeSwitcher.label' })}</label>
      <select id={selectId} value={locale} onChange={handleChange} className="ui-select">
        {availableLocales.map((item) => {
          const metadata = getLocaleMetadata(item);
          const labelId = metadata.labelId;
          const optionLabel = intl.formatMessage({ id: labelId, defaultMessage: item.toUpperCase() });
          return (
            <option key={item} value={item} dir={metadata.direction} aria-label={optionLabel}>
              {optionLabel}
            </option>
          );
        })}
      </select>
    </div>
  );
};

export default LocaleSwitcher;
