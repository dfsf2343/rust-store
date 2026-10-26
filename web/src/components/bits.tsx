import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { steamLoginUrl, type Duration, type Kit } from '../api';

export function TierPlate({ tier, size = 'md' }: { tier: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`plate plate--${size}`} role="img" aria-label={`Tier ${tier}`}>
      <span className="plate__num">{tier}</span>
    </span>
  );
}

export function DurationPicker({
  durations,
  value,
  onChange,
  kit,
  label = 'Duration',
}: {
  durations: Duration[];
  value: string;
  onChange: (id: string) => void;
  kit?: Kit;
  label?: string;
}) {
  return (
    <fieldset className="durations">
      <legend className="durations__legend">{label}</legend>
      <div className="durations__options">
        {durations.map((d) => (
          <label key={d.id} className={d.id === value ? 'durations__option is-selected' : 'durations__option'}>
            <input type="radio" name="duration" value={d.id} checked={d.id === value} onChange={() => onChange(d.id)} />
            <span className="durations__label">{d.label}</span>
            {kit && <span className="durations__price">{kit.prices[d.id]?.display}</span>}
            {d.badge && <span className="durations__badge">{d.badge}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CopyButton({ text, label, copiedLabel = 'Copied', className = 'button button--quiet' }: { text: string; label: string; copiedLabel?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {copied ? copiedLabel : label}
    </button>
  );
}

export function SteamSignIn({ returnTo, children = 'Sign in through Steam', className = 'button button--steam' }: { returnTo?: string; children?: ReactNode; className?: string }) {
  const location = useLocation();
  const target = returnTo ?? `${location.pathname}${location.search}`;
  return (
    <a className={className} href={steamLoginUrl(target)}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="button__icon">
        <circle cx="8" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 12h9M18 12v3M15.5 12v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {children}
    </a>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1 className="page-header__title">{title}</h1>
      {children && <div className="page-header__lead">{children}</div>}
    </header>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
