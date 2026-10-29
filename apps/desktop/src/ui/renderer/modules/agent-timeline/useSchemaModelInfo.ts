import React from 'react';

export function useSchemaModelInfo<T>(modelId: string, initialInfo?: T): { info: T | null; schemaMissing: boolean } {
  const [info, setInfo] = React.useState<T | null>(initialInfo ?? null);
  const [schemaMissing, setSchemaMissing] = React.useState(false);
  React.useEffect(() => {
    setInfo(initialInfo ?? null);
    setSchemaMissing(false);
  }, [modelId, initialInfo]);
  React.useEffect(() => {
    let cancelled = false;
    const fn = (window as any).neox?.getSchemaModelInfo;
    if (typeof fn !== 'function') return;
    fn(modelId)
      .then((v: any) => {
        if (cancelled) return;
        setInfo(v);
        setSchemaMissing(v === null);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [modelId]);
  return { info, schemaMissing };
}
