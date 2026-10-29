import React from 'react';

export const RowIcon: React.FC<{ src: string }> = ({ src }) => (
  <span className="nx-row-icon" aria-hidden="true">
    <img src={src} alt="" draggable={false} />
  </span>
);
