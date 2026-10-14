/**
 * The shared Signal Room presentational atoms. They live in their own module so surfaces that are
 * unit-rendered (and therefore must not pull in the stylesheet import) can use the same markup as
 * Mission Control itself.
 */
import type { ReactNode } from 'react';

export function Readiness({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <span className={`readiness ${ready ? 'is-ready' : 'needs-setup'}`}><span className="readiness-dot" />{children}</span>;
}

export function SectionHeading({ eyebrow, title, description, trailing }: { eyebrow: string; title: string; description: string; trailing?: ReactNode }) {
  return <div className="signal-heading"><div><p className="signal-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{trailing}</div>;
}
