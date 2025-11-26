import { ReactNode } from 'react';
import { classNames } from '../../lib/classNames';
import VecellsLogo from '../VecellsLogo';

export interface SkipLink {
  href: string;
  label: string;
}

export interface AppShellProps {
  skipLinks?: SkipLink[];
  skipLinksLabel?: string;
  navigationLabel: string;
  navigation: ReactNode;
  tools?: ReactNode;
  toolsClassName?: string;
  brandTitle?: string;
  brandTagline?: string;
  children: ReactNode;
}

const AppShell = ({
  skipLinks = [],
  skipLinksLabel,
  navigationLabel,
  navigation,
  tools,
  toolsClassName,
  brandTitle,
  brandTagline,
  children,
}: AppShellProps) => (
  <div className="app-shell">
    {skipLinks.length > 0 ? (
      <div className="skip-links" aria-label={skipLinksLabel}>
        {skipLinks.map(({ href, label }) => (
          <a key={href} className="skip-link" href={href}>
            {label}
          </a>
        ))}
      </div>
    ) : null}
    <header className="app-shell__header">
      <div className="app-shell__brandline">
        <div className="app-shell__brandnav">
          {brandTitle ? (
            <div className="app-shell__brand" aria-label={brandTitle}>
              <span className="app-shell__logo" aria-hidden="true">
                <VecellsLogo className="app-shell__logo-mark" />
              </span>
              <div className="app-shell__brand-text">
                <span className="app-shell__brand-title">{brandTitle}</span>
                {brandTagline ? <span className="app-shell__brand-tagline">{brandTagline}</span> : null}
              </div>
              <span className="visually-hidden">{brandTitle}</span>
            </div>
          ) : null}
          <nav id="primary-navigation" tabIndex={-1} aria-label={navigationLabel} className="app-shell__nav">
            {navigation}
          </nav>
        </div>
        {tools ? <div className={classNames('app-shell__tools', toolsClassName)}>{tools}</div> : null}
      </div>
    </header>
    {children}
  </div>
);

export default AppShell;
