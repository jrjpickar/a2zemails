import {getStore} from '@netlify/blobs';
import {mailIndex,indexStore} from './index.mjs';
import {createIntel} from './service.mjs';
import {llmConfig} from './llm.mjs';

// Shared service context for Ask AI and MCP: one mailbox, its index, the intelligence layer, AI client and usage.
import {sharedUsage} from './usage.mjs';
const usage = sharedUsage;
const attachmentCache = () => getStore({name:'attachment-text',consistency:'strong'});

export function intelContext({email,mailbox,env,preferences=null,integrations={},audit=null,fetcher=fetch,store=indexStore(),usageTracker=usage,
 timeBudget=7000,backfillLimit=150}) {
 let loaded = null;
 const ctx = {
  email,mailbox,env,preferences,integrations,audit,fetcher,
  llm:llmConfig(env),usage:usageTracker,cacheStore:attachmentCache,indexStatus:null,
  async index() {
   loaded ||= mailIndex({email,mailbox,store,timeBudget,backfillLimit}).then(value=>{ctx.indexStatus = value.status;return value;});
   return loaded;
  },
  async intel() {
   const {rows} = await ctx.index();
   ctx._intel ||= createIntel(rows,{ownEmail:email});
   return ctx._intel;
  },
  lookup(id) {return ctx._intel?.byId.get(id)||null;},
 };
 return ctx;
}
