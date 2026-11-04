/** App contracts v1. Times are ISO-8601 UTC; UI explicitly displays UTC. ENU is in metres.
 * ENU is relative to referenceXyz.
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
export interface Epoch {
  time: string;
  e: number;
  n: number;
  u: number;
  satellites: number;
  solution: Solution;
  rawQuality?: number;
  gpsWeek?: number;
  tow?: number;
  x?: number;
  y?: number;
  z?: number;
}
export interface ResultSet {
  id: string;
  name: string;
  station: string;
  source: 'ipspos';
  epochs: Epoch[];
  config: SolverConfig;
  referenceXyz?: number[];
  referenceKind?: 'configured' | 'first-valid';
  totalRows?: number;
  rejectedRows?: number;
  qualityCounts?: Record<string, number>;
  outputDir?: string;
  logPath?: string;
  engineCommit?: string;
  diagnostics?: RealtimeMetrics[];
  analysisConfig?: Record<string, string>;
  duplicateRows?: number;
  isLiveCache?: boolean;
  productHistory?: RealtimeMetrics[];
  runId?: string;
  solutionMode?: 'PPP' | 'RTK' | 'SPP';
  logVersion?: number;
  engineBuildId?: string;
  ntripLogPath?: string | null;
  productLogPath?: string | null;
  clientStatus?: RealtimeHeartbeat | null;
}
export interface NtripMountpoint {
  mountpoint: string;
  identifier: string;
  format: string;
  details: string;
  systems: string;
  network: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  nmea: boolean;
  authentication: string;
  bitrate: number | null;
  messages: number[];
  kinds: ('OBS' | 'EPH' | 'SSR')[];
}
export interface NtripProbe {
  windowSeconds: number;
  bytes: number;
  messages: { id: number; count: number }[];
}
export interface ResultEntry {
  id: string;
  name: string;
  path: string;
  station: string;
  savedAt: string;
}
export interface TaskRequest {
  input: string;
  outputDir: string;
  config: SolverConfig;
}
export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  request: TaskRequest;
  resultId?: string;
  error?: string;
  source?: 'ipspos';
  phase?: string;
  elapsedSec?: number;
  startedAt?: string;
  finishedAt?: string;
  runOpt?: string;
  preview?: ResultSet;
}
export interface LogEntry {
  id: number;
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  taskId?: string;
}
export interface WorkbenchSnapshot {
  tasks: Task[];
  results: ResultSet[];
  logs: LogEntry[];
  realtime?: RealtimeSnapshot;
  realtimeSessions?: RealtimeSnapshot[];
}

export interface OptDocument {
  sourcePath: string;
  name: string;
  text: string;
}
export interface NativeRunRequest {
  document: OptDocument;
  outputDir: string;
  runMode: 'post' | 'replay';
  playbackSpeed: number;
  referenceXyz?: [number, number, number] | null;
}
export interface EngineInfo {
  /** Optional engine outputs declared by the manifest; `product_convert` 1 = SSR to SP3 / CLK, 2 = also SSR biases to Bias-SINEX. */
  capabilities?: Record<string, number>;
  buildId: string;
  sourceModified: boolean;
  available: boolean;
  executable: string;
  commit: string;
  version: string;
  sha256: string;
  defaultOutput: string;
}
export interface NativeTask {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputDir: string;
  runOpt: string;
  request: NativeRunRequest;
  error?: string;
  resultId?: string;
  exitCode?: number;
  phase: string;
  elapsedSec: number;
  preview?: Omit<ResultSet, 'config'>;
}
export interface NativeSnapshot {
  tasks: NativeTask[];
  logs: LogEntry[];
  concurrency: number;
}
export interface RuntimePaths {
  workspace: string;
  root: string;
  postprocess: string;
  realtime: string;
  cache: string;
  logs: string;
}

/** Arrival timestamps are Unix UTC seconds; product week/tow is GPST. Missing metrics are null. */
export interface RealtimeStream {
  role: string;
  attempts?: number;
  state: number;
  errorCode: number;
  httpStatus: number;
  reconnects: number;
  bytes: number;
  frames: number;
  hasPages: number;
  lastArrival: number;
  queued: number;
  committed: number;
  dropped: number;
}
export interface RealtimeProduct {
  component: 'orbit' | 'clock' | 'code' | 'phase';
  system: string;
  decoded: number;
  fresh: number;
  signals: number;
  week: number;
  tow: number;
  age: number;
}
export interface RealtimeHeartbeat {
  schemaVersion: number;
  arrivalUnix: number;
  streamUnix?: number | null;
  productUnix?: number | null;
  week: number | null;
  tow: number | null;
  streams: RealtimeStream[];
  products: RealtimeProduct[];
}
export interface RealtimeDocument {
  sourcePath: string;
  name: string;
  values: Record<string, string>;
}
export interface RealtimeRequest {
  sourcePath: string;
  values: Record<string, string>;
  outputDir: string;
  label?: string;
  station?: string;
}
export interface RealtimeMetrics {
  time: string;
  solution: Solution;
  [key: string]: number | string | null;
}
export interface RealtimeSnapshot {
  sessionKey: string;
  label: string;
  station: string;
  sourcePath: string;
  bufferedEpochs: number;
  analysisConfig: Record<string, string>;
  logPath: string | null;
  parseError: string | null;
  logUpdatedAt: string | null;
  epochIntervalSeconds?: number | null;
  configName: string;
  productType: string;
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  id: string;
  startedAt: string;
  outputDir: string;
  processId: number | null;
  engineCommit: string;
  heartbeat: RealtimeHeartbeat | null;
  epochs: Epoch[];
  metrics: RealtimeMetrics | null;
  history: RealtimeMetrics[];
  productHistory: RealtimeMetrics[];
  logs: { time: string; line: string }[];
  error: string | null;
  referenceXyz: number[] | null;
  receivedEpochs: number;
  solutionMode?: string;
  logVersion?: number;
  engineBuildId?: string;
  ntripLogPath?: string | null;
  productLogPath?: string | null;
  statusError?: string | null;
  recordingFiles?: { name: string; path: string; role: string; bytes: number }[];
}

export type OrbitMode = 'auto' | 'keep' | 'remove';
export interface OrbitDecision {
  mode: OrbitMode;
  applied: boolean;
  reason: string;
  radialOffsets: Record<string, number>;
}
/** One side of a product comparison: SP3 orbit files and optional RINEX clock files of the same product. */
export interface ProductSet {
  name?: string;
  sp3: string[];
  clk: string[];
  /** Legacy manual choice; orbitMode takes precedence when supplied. */
  apc?: boolean;
  orbitMode?: OrbitMode;
  orbitSource?: 'has' | 'b2b';
}
export interface ProductMoments {
  mean: number;
  rms: number;
  std: number;
  max: number;
  n: number;
}
export interface ProductSatellite {
  sat: string;
  system: string;
  r: ProductMoments;
  a: ProductMoments;
  c: ProductMoments;
  d3: ProductMoments;
  clock: ProductMoments;
  clockJumps: number;
  sisre: number | null;
  coverage: number;
  outlier: boolean;
  rSeries: (number | null)[];
  aSeries: (number | null)[];
  cSeries: (number | null)[];
  clockSeries: (number | null)[];
}
export interface ProductSystem {
  system: string;
  sats: number;
  orbitEpochs: number;
  d3Median: number;
  rMedian: number;
  aMedian: number;
  cMedian: number;
  d3Rms: number;
  rMean: number;
  clockStdMedian: number | null;
  sisreMedian: number | null;
  coverage: number;
}
/** What a comparison command returns: the products that were compared and those that could not be, with the reason. */
export interface ComparisonOutcome<T> {
  results: T[];
  failures: { name: string; error: string }[];
}
export interface ProductComparison {
  name: string;
  timeSystem: string;
  epochs: number[];
  stepSeconds: number;
  systems: ProductSystem[];
  satellites: ProductSatellite[];
  /** A per-satellite radial mean was removed; this does not prove the orbit's physical reference point. */
  apc: boolean;
  orbitDecision?: OrbitDecision;
  /** Every satellite both products have, excluded or not; the page offers these for selection. */
  candidates: string[];
  excluded: string[];
  /** GEO / IGSO / MEO per satellite of the reference orbit, by orbit shape. */
  orbitClasses: Record<string, string>;
  hourly: { system: string; time: number; d3Rms: number }[];
  hints: string[];
  testOnly: string[];
  referenceOnly: string[];
}

/** Observable-specific bias comparison (Bias-SINEX), see `bias_compare.rs`. */
export interface BiasSet {
  name?: string;
  files: string[];
  /** Optional RINEX clock files; with them on both sides the narrow-lane is also compared together with the clock. */
  clocks?: string[];
  /** Optional SP3 files, only to tell GEO / IGSO / MEO satellites apart for the satellite selection. */
  orbits?: string[];
  /** Sign convention of a test product: decided against the reference (`auto`, the default), kept or inverted. */
  sign?: 'auto' | 'keep' | 'invert';
}
export type BiasKind = 'code' | 'codec' | 'phase' | 'wl' | 'nl' | 'nlc' | 'dcb';
/** The sign the biases of a test product were compared with: 1 as given, -1 inverted. */
export interface BiasSign {
  code: number;
  phase: number;
  auto: boolean;
  /** Correlation of the code biases with the reference that decided it, when measurable. */
  correlation: number | null;
}
export interface BiasItem {
  sat: string;
  system: string;
  signal: string;
  kind: BiasKind;
  mean: number;
  rms: number;
  temporalStd: number;
  n: number;
  outlier: boolean;
  /** Wide-lane and narrow-lane items: residual in cycles per grid epoch, null where the satellite is missing. */
  series?: (number | null)[];
}
/** Residuals of all satellites and epochs; `counts[i]` covers `[min + i * width, min + (i + 1) * width)`. */
export interface BiasHistogram {
  min: number;
  width: number;
  counts: number[];
}
export interface BiasRow {
  system: string;
  signal: string;
  kind: BiasKind;
  unit: 'ns' | 'cyc';
  sats: number;
  offset: number;
  rms: number;
  max: number;
  temporalStd: number;
  withinTolerance: number | null;
  outliers: number;
  totalRms: number;
  /** Cyclic rows: share of satellite-epochs within ±0.1 cycles. */
  epochWithin: number | null;
  histogram: BiasHistogram;
  /** Per grid epoch: RMS over satellites after the datum was removed, and the datum itself. */
  series: { rms: (number | null)[]; datum: (number | null)[] };
}
export interface BiasComparison {
  name: string;
  timeSystem: string;
  /** First grid epoch `YYYY-MM-DDTHH:MM:SS` in the products' time system; `epochs` samples every `step` seconds. */
  start: string;
  step: number;
  epochs: number;
  /** Every satellite both products have, excluded or not; the page offers these for selection. */
  satellites: string[];
  excluded: string[];
  sign: BiasSign;
  /** GEO / IGSO / MEO per satellite, from the SP3 files given to the page; empty without any. */
  orbitClasses: Record<string, string>;
  rows: BiasRow[];
  items: BiasItem[];
  hints: string[];
  testOnly: string[];
  referenceOnly: string[];
}
