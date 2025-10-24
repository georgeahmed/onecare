/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../src/theme';
import { I18nProvider } from '../src/i18n';
import { AuthProvider, createDevSession } from '../src/lib/auth';
import ClinicSwitcher from '../src/components/ClinicSwitcher';
import useAuth from '../src/hooks/useAuth';

const ActiveClinicViewer = () => {
  const { activeClinicId } = useAuth();
  return <div data-testid="active-clinic">{activeClinicId ?? 'none'}</div>;
};

const renderSwitcher = () => {
  const session = createDevSession();
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider initialSession={session}>
          <ClinicSwitcher />
          <ActiveClinicViewer />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};

describe('ClinicSwitcher', () => {
  it('renders a select element for multi-clinic users and updates context', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const select = screen.getByRole('combobox');
    expect(select).toBeTruthy();
    expect(screen.getByTestId('active-clinic').textContent).toBe('demo');

    await user.selectOptions(select, 'north');
    expect(screen.getByTestId('active-clinic').textContent).toBe('north');
  });

  it('shows a badge when there is only one clinic', () => {
    const singleClinicSession = { ...createDevSession(), clinics: [{ id: 'solo', name: 'Solo Clinic' }] };
    render(
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider initialSession={singleClinicSession}>
            <ClinicSwitcher />
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    );

    expect(screen.getByText('Solo Clinic')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
