import React, { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { SessionCheckpointMeta } from '../shared/ipc';

export interface RuntimeLogEntry {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
  timestamp: number;
}

interface RuntimeState {
  runtimeLogs: RuntimeLogEntry[];
  runtimeLogVisible: boolean;
  checkpoints: SessionCheckpointMeta[];
  selectedCheckpointId: string;
}

const initialState: RuntimeState = {
  runtimeLogs: [],
  runtimeLogVisible: false,
  checkpoints: [],
  selectedCheckpointId: '',
};

type Action =
  | { type: 'setRuntimeLogs'; payload: RuntimeLogEntry[] | ((prev: RuntimeLogEntry[]) => RuntimeLogEntry[]) }
  | { type: 'appendRuntimeLog'; payload: RuntimeLogEntry }
  | { type: 'setRuntimeLogVisible'; payload: boolean }
  | { type: 'setCheckpoints'; payload: SessionCheckpointMeta[] }
  | { type: 'setSelectedCheckpointId'; payload: string };

const reducer = (state: RuntimeState, action: Action): RuntimeState => {
  switch (action.type) {
    case 'setRuntimeLogs': {
      const next = typeof action.payload === 'function' ? action.payload(state.runtimeLogs) : action.payload;
      return { ...state, runtimeLogs: next };
    }
    case 'appendRuntimeLog':
      return { ...state, runtimeLogs: [action.payload, ...state.runtimeLogs].slice(0, 200) };
    case 'setRuntimeLogVisible':
      return { ...state, runtimeLogVisible: action.payload };
    case 'setCheckpoints':
      return { ...state, checkpoints: action.payload };
    case 'setSelectedCheckpointId':
      if (state.selectedCheckpointId === action.payload) {
        return state;
      }
      return { ...state, selectedCheckpointId: action.payload };
    default:
      return state;
  }
};

const RuntimeStoreContext = createContext<{
  state: RuntimeState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export const RuntimeStoreProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <RuntimeStoreContext.Provider value={value}>{children}</RuntimeStoreContext.Provider>;
};

const useRuntimeStore = () => {
  const ctx = useContext(RuntimeStoreContext);
  if (!ctx) throw new Error('useRuntimeStore must be used within RuntimeStoreProvider');
  return ctx;
};

export const useRuntimeState = () => useRuntimeStore().state;

export const useRuntimeActions = () => {
  const { dispatch } = useRuntimeStore();
  return useMemo(
    () => ({
      setRuntimeLogs: (logs: RuntimeLogEntry[] | ((prev: RuntimeLogEntry[]) => RuntimeLogEntry[])) =>
        dispatch({ type: 'setRuntimeLogs', payload: logs }),
      appendRuntimeLog: (entry: RuntimeLogEntry) => dispatch({ type: 'appendRuntimeLog', payload: entry }),
      setRuntimeLogVisible: (value: boolean) => dispatch({ type: 'setRuntimeLogVisible', payload: value }),
      setCheckpoints: (list: SessionCheckpointMeta[]) => dispatch({ type: 'setCheckpoints', payload: list }),
      setSelectedCheckpointId: (id: string) => dispatch({ type: 'setSelectedCheckpointId', payload: id }),
    }),
    [dispatch],
  );
};
