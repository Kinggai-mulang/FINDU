import type {RealtimeDocument} from '../../contracts';

export type RealtimeEditor={document?:RealtimeDocument;output:string;label:string;station:string};
// Drafts survive navigation, but removed sessions must release their in-memory configuration.
export const realtimeEditors=new Map<string,RealtimeEditor>();
export const forgetRealtimeDraft=(key:string)=>{realtimeEditors.delete(key);};
