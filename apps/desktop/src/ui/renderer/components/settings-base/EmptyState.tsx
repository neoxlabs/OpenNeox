import React from 'react';

export const EmptyState: React.FC<{
  icon: React.ReactNode;
  art?: string;
  title: string;
  desc?: string;
  actions?: React.ReactNode;
  className?: string;
}> = ({ icon, art, title, desc, actions, className }) => (
  <div className={['nx-empty', className].filter(Boolean).join(' ')}>
    {art
      ? <img className="nx-empty__art" src={art} alt="" aria-hidden draggable={false} />
      : <div className="nx-empty__icon" aria-hidden>{icon}</div>}
    <h3 className="nx-empty__title">{title}</h3>
    {desc && <p className="nx-empty__desc">{desc}</p>}
    {actions && <div className="nx-empty__actions">{actions}</div>}
  </div>
);
