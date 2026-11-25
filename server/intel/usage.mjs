import {usageStore} from './llm.mjs';
// One usage tracker per function instance, shared by Ask AI, sorting, summaries, writing and MCP.
export const sharedUsage = usageStore();
