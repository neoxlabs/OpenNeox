
export type SqlScope = { clause: string; params: string[] };

export function withLocalUsageScope(base: SqlScope): SqlScope {
    return {
        clause: `${base.clause} AND provider NOT IN ('neox-cloud', 'Neox Cloud')`,
        params: base.params,
    };
}
