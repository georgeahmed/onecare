import { ReactNode } from 'react';
import { classNames } from '../../lib/classNames';

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
  children: ReactNode;
}

const AppShell = ({
  skipLinks = [],
  skipLinksLabel,
  navigationLabel,
  navigation,
  tools,
  toolsClassName,
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
    <header>
      <nav id="primary-navigation" tabIndex={-1} aria-label={navigationLabel}>
        {navigation}
      </nav>
      {tools ? <div className={classNames('app-shell__tools', toolsClassName)}>{tools}</div> : null}
    </header>
    {children}
  </div>
);

export default AppShell;
