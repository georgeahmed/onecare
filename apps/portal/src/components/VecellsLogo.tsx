import { classNames } from '../lib/classNames';

interface VecellsLogoProps {
  className?: string;
  title?: string;
}

const VecellsLogo = ({ className, title }: VecellsLogoProps) => {
  const accessibilityProps = title
    ? { role: 'img', 'aria-label': title }
    : { role: 'presentation', 'aria-hidden': true as const };

  return (
    <svg
      viewBox="0 0 64 64"
      focusable="false"
      className={classNames('vecells-logo', className)}
      {...accessibilityProps}
    >
      {title ? <title>{title}</title> : null}
      <rect x="9" y="9" width="46" height="46" rx="11" className="vecells-logo__frame" />
      <path d="M16 20 32 44 48 20" className="vecells-logo__path" />
      <path d="M20.5 22.5C26.5 30.5 37.5 30.5 43.5 22.5" className="vecells-logo__path vecells-logo__path--highlight" />
      <path d="M32 44V30.5" className="vecells-logo__spine" />
      <circle cx="16" cy="20" r="3.1" className="vecells-logo__node" />
      <circle cx="48" cy="20" r="3.1" className="vecells-logo__node vecells-logo__node--highlight" />
      <circle cx="32" cy="44" r="3.8" className="vecells-logo__node vecells-logo__node--base" />
      <circle cx="32" cy="30.5" r="2.1" className="vecells-logo__node vecells-logo__node--pulse" />
    </svg>
  );
};

export default VecellsLogo;
