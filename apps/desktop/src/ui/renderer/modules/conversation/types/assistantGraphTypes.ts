export interface WorkerActivityInfo {
  type?: string;
  toolName?: string;
  title?: string;
}

export interface WorkerInfo {
  agentId: string;
  status: string;
  role?: string;
  task?: string;
  activities: WorkerActivityInfo[];
}

export interface TeamInfo {
  teamId: string;
  workerIds: string[];
  status: string;
  mode?: string;
}

export interface AssistantCommunicationInfo {
  type?: string;
  fromPid?: string;
  toPid?: string;
  boardType?: string;
}

export interface AssistantState {
  main: {
    state: string;
    currentTask?: string;
  };
  teams: TeamInfo[];
  workers: WorkerInfo[];
  communications: AssistantCommunicationInfo[];
}
