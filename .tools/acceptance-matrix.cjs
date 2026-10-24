// Map the release plan to executed regressions and dated device/cloud evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,out='.build-cache/verification';
const json=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const fact=file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')});
const summary=json(out+'/summary.json');assert.equal(summary.version,version);assert.ok(summary.rust.app>=53&&summary.rust.core>=49);
const inventory=fs.readFileSync(path.join(root,out,'app-test-inventory.txt'),'utf8');
const definitions=[
 ['local-only',[],['windows-evidence/smoke-results.json','android-evidence/smoke-results.json','handoff-evidence/windows.json','handoff-evidence/android.json']],
 ['empty-first-download',['first_empty_device_downloads_without_prompt_or_upload'],['cloud-evidence/roundtrip.json']],
 ['initial-choice-preserves-local',['cancellation_after_download_preserves_local_data_and_revision','empty_json_files_do_not_count_as_existing_business_data'],['cloud-evidence/roundtrip.json']],
 ['concurrent-claim-and-publish',['simultaneous_claims_have_exactly_one_winner','stale_revision_or_lease_cannot_publish'],['cloud-evidence/windows-contention.json']],
 ['expired-lease-rejects-old-owner',['expired_takeover_requires_confirmation_and_invalidates_the_old_owner','expired_local_owner_must_reconcile_before_becoming_editable_again'],['cloud-evidence/windows-expiry.json','cloud-evidence/expiry-cleanup.json']],
 ['stale-base-preserves-new-remote',['stale_revision_or_lease_cannot_publish','download_does_not_replace_edit_made_during_network'],['cloud-evidence/windows-contention.json']],
 ['immediate-exit-and-process-death',['writable_only_after_initial_sync_and_durable_dirty_before_write','exit_timer_checkpoint_is_durable_and_rejects_running_replacement'],['cloud-evidence/roundtrip.json','handoff-evidence/android.json','windows-evidence/followup-ui-results.json']],
 ['commit-acknowledgement-failure',['acknowledged_content_retry_does_not_publish_a_second_revision'],[]],
 ['edit-during-transfer',['upload_releases_storage_and_preserves_edits_until_next_commit','download_does_not_replace_edit_made_during_network'],[]],
 ['download-does-not-become-dirty',['first_empty_device_downloads_without_prompt_or_upload'],['cloud-evidence/roundtrip.json']],
 ['corruption-and-wrong-password',['bad_nonce_returns_error_instead_of_panicking','encrypted_roundtrip_and_tamper_detection','corrupt_state_and_profile_fail_closed'],['android-evidence/recovery-checks.json']],
 ['path-and-payload-validation',['rejects_paths_and_bad_json_before_writing'],['android-evidence/recovery-checks.json']],
 ['write-failure-and-interrupted-transaction',['isolated_edit_failure_leaves_all_live_files_and_config_unchanged','recovers_interrupted_transaction_including_config'],['android-evidence/recovery-checks.json']],
 ['android-background-and-restart',[],['android-evidence/lifecycle-results.json','honor70-evidence/project-certificate/upgrade.json']],
 ['delete-and-undo-roundtrip',['complete_snapshot_removes_stale_files_and_is_idempotent'],['cloud-evidence/roundtrip.json','windows-evidence/ui-results.json']],
 ['credentials-and-device-settings',['credential_update_failure_preserves_active_profile_and_all_old_secrets','missing_credential_is_detected_before_any_writes_and_success_keeps_device_id','credentials_are_not_snapshot_fields'],['android-evidence/smoke-results.json','cloud-evidence/roundtrip.json']]
];
const evidence=new Map(),results=[];
for(const[name,tests,files]of definitions){
 for(const test of tests)assert.ok(inventory.includes('::'+test+': test'),'Executed test is missing: '+test);
 for(const file of files){const relative='.build-cache/'+file,value=json(relative),checks=value.results||value.checks;
  if(file==='cloud-evidence/expiry-cleanup.json')assert.equal(value.passed,true);
  else assert.ok(checks?.length&&checks.every(x=>x.passed),'Failed evidence: '+file);
  evidence.set(relative,{...fact(relative),recordedAt:value.recordedAt,version:value.version||null,historicalProtocolEvidence:file.includes('windows-expiry')});
 }
 results.push({name,passed:true,executedUnitTests:tests,evidence:files.map(x=>'.build-cache/'+x)});
}
const record={recordedAt:new Date().toISOString(),version,method:'Executed Rust regressions plus native IPC, visible UI and actual cloud/device evidence; individual files state their testing layer and date.',limits:['Production lease expiry is earlier real-time protocol evidence, supplemented by current deterministic regressions.','Fault injection covers storage failures; no claim of physically filling the phone storage.','OEM multi-day background behavior and three-day daily use remain post-release observation.'],unitSummary:fact(out+'/summary.json'),testInventory:fact(out+'/app-test-inventory.txt'),evidence:[...evidence.values()],results};
fs.writeFileSync(path.join(root,out,'acceptance-matrix.json'),JSON.stringify(record,null,2));console.log('PASS release acceptance matrix: '+results.length+' supported scenarios');
