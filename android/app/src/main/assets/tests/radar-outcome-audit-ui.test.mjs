import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../radar-outcome-audit.html',import.meta.url),'utf8');
const moduleSource=await readFile(new URL('../radar-outcome-audit.mjs',import.meta.url),'utf8');

test('every DOM id requested by the radar outcome audit module exists in its HTML page',()=>{
  const htmlIds=new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match=>match[1]));
  const requestedIds=[...moduleSource.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match=>match[1]);
  assert.ok(requestedIds.length>0,'the audit module declares DOM dependencies');
  for(const id of requestedIds)assert.ok(htmlIds.has(id),'missing audit HTML element id: '+id);
});

test('twelve-radar outcome report mounts into the visible radarRoot and states its measurement scope',()=>{
  assert.match(moduleSource,/getElementById\(['"]radarRoot['"]\)/);
  assert.match(moduleSource,/لا يحصي وحده جميع العملات التي فاتت الرصد/);
  assert.match(html,/id=["']radarRoot["']/);
});
