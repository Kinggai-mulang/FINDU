/** App contracts v1. Times are ISO-8601 UTC; UI explicitly displays UTC. ENU is in metres.
 * source=mock: synthetic errors. source=ipspos: ENU relative to referenceXyz.
 * first-valid is a relative origin, not an independent accuracy reference.
 */
export type Solution = 'NONE' | 'SPP' | 'SPP_EKF' | 'PRE' | 'CODE' | 'FLOAT' | 'FLOFIX' | 'FIX' | 'HOLD' | 'REFERENCE';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface SolverConfig {
  schemaVersion: 1;
  name: string;
  mode: 'SPP' | 'RTK' | 'PPP';
  systems: ('GPS' | 'BDS' | 'GAL' | 'GLO')[];
  elevationDeg: number;
  intervalSec: number;
  productPath: string;
}
export interface Epoch { time: string; e: number; n: number; u: number; satellites: number; solution: Solution; rawQuality?:number; gpsWeek?:number; tow?:number; x?:number; y?:number; z?:number }
export interface ResultSet { id: string; name: string; station: string; source: 'mock'|'ipspos'; epochs: Epoch[]; config: SolverConfig; referenceXyz?:number[]; referenceKind?:'configured'|'first-valid'; totalRows?:number; rejectedRows?:number; qualityCounts?:Record<string,number>; outputDir?:string; logPath?:string; engineCommit?:string;diagnostics?:RealtimeMetrics[];analysisConfig?:Record<string,string>;duplicateRows?:number;isLiveCache?:boolean;productHistory?:RealtimeMetrics[];runId?:string;solutionMode?:'PPP'|'RTK'|'SPP';logVersion?:number;engineBuildId?:string;ntripLogPath?:string|null;productLogPath?:string|null;clientStatus?:RealtimeHeartbeat|null }
export interface ResultEntry {id:string;name:string;path:string;station:string;savedAt:string}
export interface Statistics { rmsE: number; rmsN: number; rmsU: number; fixedRate: number; validEpochs: number; totalEpochs: number }
export interface TaskRequest { input: string; outputDir: string; config: SolverConfig; simulateFailure: boolean }
export interface Task { id: string; name: string; status: TaskStatus; progress: number; createdAt: string; request: TaskRequest; resultId?: string; error?: string; source?:'mock'|'ipspos'; phase?:string; elapsedSec?:number; startedAt?:string; finishedAt?:string; runOpt?:string; preview?:ResultSet }
export interface LogEntry { id: number; time: string; level: 'info' | 'warn' | 'error'; message: string; taskId?: string }
export interface WorkbenchSnapshot { tasks: Task[]; results: ResultSet[]; logs: LogEntry[]; realtime?:RealtimeSnapshot;realtimeSessions?:RealtimeSnapshot[]; live: { station: string; running: boolean; epochs: Epoch[] } }
export interface EngineService {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => WorkbenchSnapshot;
  createTask: (request: TaskRequest) => string;
  cancelTask: (id: string) => void;
  setStation: (station: string) => void;
  startLive: () => void;
  stopLive: () => void;
}

export interface OptDocument {sourcePath:string;name:string;text:string}
export interface NativeRunRequest {document:OptDocument;outputDir:string;runMode:'post'|'replay';playbackSpeed:number;referenceXyz?:[number,number,number]|null}
export interface EngineInfo {buildId:string;sourceModified:boolean;available:boolean;executable:string;commit:string;version:string;sha256:string;defaultOutput:string}
export interface NativeTask {id:string;name:string;status:TaskStatus;progress:number;createdAt:string;startedAt?:string;finishedAt?:string;outputDir:string;runOpt:string;request:NativeRunRequest;error?:string;resultId?:string;exitCode?:number;phase:string;elapsedSec:number;preview?:Omit<ResultSet,'config'>}
export interface NativeSnapshot {tasks:NativeTask[];logs:LogEntry[];concurrency:number}
export interface RuntimePaths {workspace:string;root:string;postprocess:string;realtime:string;cache:string;logs:string}

/** Arrival timestamps are Unix UTC seconds; product week/tow is GPST. Missing metrics are null. */
export interface RealtimeStream {role:string;attempts?:number;state:number;errorCode:number;httpStatus:number;reconnects:number;bytes:number;frames:number;hasPages:number;lastArrival:number;queued:number;committed:number;dropped:number}
export interface RealtimeProduct {component:'orbit'|'clock'|'code'|'phase';system:string;decoded:number;fresh:number;signals:number;week:number;tow:number;age:number}
export interface RealtimeHeartbeat {schemaVersion:number;arrivalUnix:number;streamUnix?:number|null;productUnix?:number|null;week:number|null;tow:number|null;streams:RealtimeStream[];products:RealtimeProduct[]}
export interface RealtimeDocument {sourcePath:string;name:string;values:Record<string,string>}
export interface RealtimeRequest {sourcePath:string;values:Record<string,string>;outputDir:string;label?:string;station?:string}
export interface RealtimeMetrics {time:string;solution:Solution;[key:string]:number|string|null}
export interface RealtimeSnapshot {sessionKey:string;label:string;station:string;sourcePath:string;bufferedEpochs:number;analysisConfig:Record<string,string>;logPath:string|null;parseError:string|null;logUpdatedAt:string|null;configName:string;productType:string;state:'idle'|'starting'|'running'|'stopping'|'stopped'|'failed';id:string;startedAt:string;outputDir:string;processId:number|null;engineCommit:string;heartbeat:RealtimeHeartbeat|null;epochs:Epoch[];metrics:RealtimeMetrics|null;history:RealtimeMetrics[];productHistory:RealtimeMetrics[];logs:{time:string;line:string}[];error:string|null;referenceXyz:number[]|null;receivedEpochs:number;solutionMode?:string;logVersion?:number;engineBuildId?:string;ntripLogPath?:string|null;productLogPath?:string|null;statusError?:string|null;recordingFiles?:{name:string;path:string;role:string;bytes:number}[]}


