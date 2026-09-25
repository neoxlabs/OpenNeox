export interface JavaDebugStatus {
  javaAvailable: boolean;
  javaVersion?: string;
  jarFound: boolean;
  jarPath?: string;
  ready: boolean;
}
