import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, X } from 'lucide-react';
import type { ItemStatus, PurchaseStatus } from '../domain/types';
import { PURCHASE_STATUS_LABEL, STATUS_LABEL } from '../domain/types';
import { money, moneySigned } from '../domain/format';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 border-b border-line pb-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2.5">
            <span className="h-px w-5 bg-copper" />
            <span className="eyebrow">{eyebrow}</span>
          </div>
          <h1 className="text-[26px] font-medium leading-none tracking-[-0.025em] text-cream sm:text-[30px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-2.5 max-w-3xl text-[13px] leading-relaxed text-muted">{description}</p>
          ) : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'px-4 py-4 sm:px-5',
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || actions ? (
        <div className="panel-head">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[13px] font-medium leading-tight text-cream">{title}</h2>
            ) : null}
            {subtitle ? <p className="mt-1 text-[11.5px] text-dim">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className={bodyClassName}>{children}</div>}
    </section>
  );
}

export function StatusTag({ status, className = '' }: { status: ItemStatus; className?: string }) {
  return (
    <span className={`status status-${status} ${className}`}>{STATUS_LABEL[status]}</span>
  );
}

const PURCHASE_STATUS_CLASS: Record<PurchaseStatus, string> = {
  draft: 'status-ghost',
  requested: 'status-attention',
  partial: 'status-attention',
  received: 'status-normal',
  cancelled: 'status-ghost',
};

export function PurchaseStatusTag({ status }: { status: PurchaseStatus }) {
  return (
    <span className={`status ${PURCHASE_STATUS_CLASS[status]}`}>
      {PURCHASE_STATUS_LABEL[status]}
    </span>
  );
}

export function Money({
  cents,
  signed = false,
  className = '',
}: {
  cents: number;
  signed?: boolean;
  className?: string;
}) {
  return (
    <span className={`num ${className}`}>{signed ? moneySigned(cents) : money(cents)}</span>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-dim transition-colors hover:text-cream"
    >
      <ArrowLeft size={13} strokeWidth={1.7} />
      {children}
    </Link>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 grid h-11 w-11 place-items-center border border-line text-dim">
        {icon}
      </div>
      <h3 className="text-[15px] font-medium text-cream">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-[11px] leading-relaxed text-dim">{hint}</p> : null}
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  eyebrow,
  title,
  description,
  children,
  footer,
  width = 'max-w-[480px]',
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 anim-fade"
      />
      <div
        className={`relative flex h-full w-full ${width} flex-col border-l border-line bg-panel anim-slide`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
            <h2 className="text-[17px] font-medium tracking-[-0.01em] text-cream">{title}</h2>
            {description ? (
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="btn btn-quiet btn-sm" aria-label="Fechar">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/75 anim-fade"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[440px] border border-line bg-panel anim-rise"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-medium text-cream">{title}</h2>
          <button type="button" onClick={onClose} className="text-dim hover:text-cream" aria-label="Fechar">
            <X size={15} />
          </button>
        </div>
        <div className="px-5 py-4 text-[12.5px] leading-relaxed text-muted">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function InlineLink({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1 text-[12px] text-copper transition-colors hover:text-copper-hi ${className}`}
    >
      {children}
      <ArrowUpRight size={12} strokeWidth={1.7} />
    </Link>
  );
}

export function ToneNote({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warn';
  children: ReactNode;
}) {
  return (
    <div
      className={`border-l px-3 py-2.5 text-[11.5px] leading-relaxed ${
        tone === 'warn'
          ? 'border-copper/60 bg-copper/[0.04] text-muted'
          : 'border-line-strong bg-raised/50 text-dim'
      }`}
    >
      {children}
    </div>
  );
}
