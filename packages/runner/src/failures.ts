export type FailureKind = 'quota' | 'auth' | 'model' | 'transport' | 'stalled' | 'execution';
export function classifyFailure(message: string): FailureKind {
 if (/usage limit|quota|rate.limit|too many requests|insufficient_quota|429/i.test(message)) return 'quota';
 if (/unauthenticated|authentication|unauthorized|invalid.*(?:key|token)|401|403/i.test(message)) return 'auth';
 if (/model.*(?:not found|not available|not supported|does not exist)|unsupported model/i.test(message)) return 'model';
 if (/connection|network|websocket|stream disconnected|fetch failed|502|503/i.test(message)) return 'transport';
 return 'execution';
}
export function isInfrastructure(kind?: string): boolean { return ['quota','auth','model','transport'].includes(kind ?? ''); }
export class ModelFailure extends Error {
 constructor(message:string, readonly kind:FailureKind) {super(message);}
}
