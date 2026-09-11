import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig } from './policy.js';
import { validateTickets, normalizeReservation } from './scheduler.js';
import type { RunnerConfig, Ticket } from './types.js';
export interface Config extends RunnerConfig {
 idleTimeoutMs:number;port:number;maxTicketsPerRun:number;workerTimeoutMs:number;checkTimeoutMs:number;
 maxObservedTokensPerRun:number;publish:boolean;expectedRemote:string;codexCommand:string;
 checks:string[][];allowedPaths:Record<string,string[]>;ticketChecks:Record<string,string[][]>;
}
export async function loadProject(root:string):Promise<{config:Config;tickets:Ticket[]}> {
 const config=JSON.parse(await readFile(join(root,'runner.config.json'),'utf8')) as Config;
 config.allowedPaths??={};config.ticketChecks??={};config.repairPaths??=['package.json','pnpm-lock.yaml'];
 config.idleTimeoutMs??=180000;
 validateConfig(config);
 for(const key of ['idleTimeoutMs','port','maxTicketsPerRun','workerTimeoutMs','checkTimeoutMs','maxObservedTokensPerRun'] as const)if(!Number.isSafeInteger(config[key])||config[key]<1)throw new Error(`Invalid config.${key}`);
 if(config.port<1024||config.port>65535)throw new Error('Port must be between 1024 and 65535');
 if(typeof config.publish!=='boolean'||typeof config.codexCommand!=='string'||!config.codexCommand||typeof config.expectedRemote!=='string')throw new Error('Invalid execution configuration');
 const tickets=(JSON.parse(await readFile(join(root,'BACKLOG.json'),'utf8')) as {tickets:Ticket[]}).tickets;
 const ids=new Set(tickets.map(t=>t.id));
 const checks=(value:string[][])=>{if(!Array.isArray(value)||!value.length||value.some(c=>!Array.isArray(c)||!c.length||c.some(v=>typeof v!=='string'||!v)))throw new Error('Checks must be nonempty argv arrays');};
 checks(config.checks);
 for(const [id,paths] of Object.entries(config.allowedPaths)){if(!ids.has(id)||!Array.isArray(paths))throw new Error('Unknown allowedPaths ticket');paths.forEach(normalizeReservation);}
 for(const [id,value]of Object.entries(config.ticketChecks)){if(!ids.has(id))throw new Error('Unknown ticketChecks ticket');checks(value);}
 for(const path of config.repairPaths) normalizeReservation(path);
 for(const id of Object.keys(config.ticketOverrides))if(!ids.has(id))throw new Error(`Unknown model override: ${id}`);
 validateTickets(tickets);
 return {config,tickets};
}
