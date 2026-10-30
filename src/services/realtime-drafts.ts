import { invoke } from '@tauri-apps/api/core';
import type { RealtimeDocument, RealtimeRequest } from '../../contracts';
import { sessionName } from './session-names';

export type RealtimeEditor = { document?: RealtimeDocument; output: string; label: string; station: string };
// Drafts survive navigation, but removed sessions must release their in-memory configuration.
export const realtimeEditors = new Map<string, RealtimeEditor>();
export const forgetRealtimeDraft = (key: string) => {
  realtimeEditors.delete(key);
};

export const manualSource = 'findyou-live-draft:';
export const defaults: Record<string, string> = {
  GNSS_PMode: '3',
  GNSS_RoveSampleTime: '1.0',
  GNSS_ARMode: '2',
  PRODUCT_NTRIP_Type: 'SSR',
  ROVE_NTRIP_Format: 'RTCM3',
  BASE_NTRIP_Format: 'RTCM3',
  NTRIP_RequestMode: 'V2',
  GNSS_bUsePPPAntenna: 'ON',
  GNSS_bRecordRTCM3: 'OFF',
  GNSS_bOutputNMEA: 'ON',
  GNSS_bOutputULog: 'ON',
  GNSS_bOutputLOG: 'ON',
  IPSClient_bStatusLog: 'ON',
  GNSS_ULogLevel: 'INFO',
  BASE_NTRIP_Port: '2101',
  BASE_NTRIP_DataType: 'OBS|EPH',
  ROVE_NTRIP_Port: '2101',
  PRODUCT_NTRIP_Port: '2101',
  BIAS_NTRIP_Port: '2101',
  ATMO_NTRIP_Port: '2101',
  ROVE_NTRIP_DataType: 'OBS|EPH',
  PRODUCT_NTRIP_DataType: 'EPH|ORB|CLK|CODE_OSB|PHASE_OSB|TROP|ION',
  BIAS_NTRIP_DataType: 'CODE_OSB|PHASE_OSB',
  ATMO_NTRIP_DataType: 'TROP|ION',
};
// Credentials survive page switches only in memory. Persistent preferences deliberately exclude them.
export function seedRealtimeDraft(key: string, doc: RealtimeDocument, label = sessionName(doc.name, 1)) {
  realtimeEditors.set(key, {
    document: {
      ...doc,
      values: {
        ...defaults,
        ...doc.values,
        ...(doc.values.GNSS_PMode === '0' ? { GNSS_bRecordRTCM3: 'ON' } : {}),
        ...(!['6', '7', '8'].includes(doc.values.GNSS_PMode) && ['HAS', 'B2B'].includes(doc.values.PRODUCT_NTRIP_Type)
          ? { GNSS_ARMode: '0' }
          : {}),
        ...(doc.values.PRODUCT_NTRIP_Type === 'B2B' && !doc.values.ROVE_NTRIP_Format
          ? { ROVE_NTRIP_Format: 'UNICORE' }
          : {}),
      },
    },
    output: '',
    label,
    station: doc.values.ROVE_NTRIP_Mountpoint || '未指定测站',
  });
}
export async function realtimeDraftRequest(key: string): Promise<RealtimeRequest | null> {
  const e = realtimeEditors.get(key);
  if (!e?.document) return null;
  if (e.document.sourcePath.startsWith(manualSource))
    e.document = await invoke<RealtimeDocument>('create_live_document', { values: e.document.values });
  return {
    sourcePath: e.document.sourcePath,
    values: e.document.values,
    outputDir: e.output,
    label: e.label,
    station: e.station,
  };
}
