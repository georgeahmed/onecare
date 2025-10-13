import { ChangeEvent, useId } from 'react';
import { useIntl } from 'react-intl';
import { supportedLocales, useLocale } from '../i18n';

const LocaleSwitcher = () => {
  const { locale, setLocale } = useLocale();
  const intl = useIntl();
  const selectId = useId();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = event.target.value;
    if (nextLocale === locale) return;
    if (supportedLocales.includes(nextLocale as (typeof supportedLocales)[number])) {
      setLocale(nextLocale as (typeof supportedLocales)[number]);
    }
  };

  return (
    <div className="locale-switcher">
      <label htmlFor={selectId}>{intl.formatMessage({ id: 'app.localeSwitcher.label' })}</label>
      <select id={selectId} value={locale} onChange={handleChange}>
        {supportedLocales.map((item) => {
          const labelId = `locale.name.${item}`;
          const optionLabel = intl.formatMessage({ id: labelId, defaultMessage: item.toUpperCase() });
          return (
            <option key={item} value={item}>
              {optionLabel}
            </option>
          );
        })}
      </select>
    </div>
  );
};

export default LocaleSwitcher;
