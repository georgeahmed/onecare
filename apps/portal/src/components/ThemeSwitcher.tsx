import { ChangeEvent, useId } from 'react';
import { useIntl } from 'react-intl';
import { useTheme, type PortalTheme } from '../theme';

const THEME_OPTIONS: PortalTheme[] = ['light', 'dark', 'high-contrast'];

const ThemeSwitcher = () => {
  const intl = useIntl();
  const { theme, setTheme } = useTheme();
  const selectId = useId();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as PortalTheme;
    if (next === theme) return;
    if (THEME_OPTIONS.includes(next)) {
      setTheme(next);
    }
  };

  return (
    <div className="theme-switcher">
      <label htmlFor={selectId}>{intl.formatMessage({ id: 'theme.switcher.label' })}</label>
      <select id={selectId} value={theme} onChange={handleChange} className="ui-select">
        {THEME_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {intl.formatMessage({ id: `theme.option.${option}` })}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ThemeSwitcher;
