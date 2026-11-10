'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validateSourceRun,WORKFLOW,WORKFLOW_NAME} = require('./verify-source-run.cjs');
const source = () => ({
  id: 12345678,
  name: WORKFLOW_NAME,
  path: WORKFLOW,
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  repository: {full_name: 'panasenkof/PersonalAI'},
  head_repository: {full_name: 'panasenkof/PersonalAI'},
});
test('trusted main source run yields the immutable git SHA', () => {
  assert.equal(validateSourceRun(source(),'panasenkof/PersonalAI',12345678),'a'.repeat(40));
});
test('untrusted PRs, forks, other workflows and failures cannot stage native code',()=>{
  const mutations = [
    {id:111}, {name:'CI'}, {path:'.github/workflows/ci.yml'},
    {event:'pull_request'}, {head_branch:'feature/evil'},
    {head_sha:'a'.repeat(39)+'g'}, {status:'in_progress'},
    {conclusion:'cancelled'}, {conclusion:'failure'},
    {repository:{full_name:'other/repo'}},
    {head_repository:{full_name:'other/repo'}},
    {head_repository:null},
  ];
  for (const change of mutations){
    assert.throws(()=>validateSourceRun({...source(),...change},'panasenkof/PersonalAI',12345678),
      /tdlib_source_run_untrusted/,JSON.stringify(change));
  }
  assert.throws(()=>validateSourceRun(source(),'panasenkof/PersonalAI',222),/untrusted/);
  assert.throws(()=>validateSourceRun(source(),'../../../x',12345678),/invalid/);
});
