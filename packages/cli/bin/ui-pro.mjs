#!/usr/bin/env node
// The workspace packages are TypeScript source; tsx teaches Node to load them.
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/main.ts', import.meta.url).href);
