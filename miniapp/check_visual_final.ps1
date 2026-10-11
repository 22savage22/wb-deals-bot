param([switch]$TryRemainingOnce)
# Existing isolated deployment only. Cache reads precede the single optional
# remaining inference. Never initialise/reset a ledger or retry an AI POST.
$ErrorActionPreference='Stop'
$visionRoot='D:\WB-Vision-Agent'
$visionBase='https://wb-finds-visual-staging.valeramyakishev000.workers.dev'
$visionOutput=Join-Path $visionRoot '.test-temp\gemma-150-20261011\verification.json'
$visionConfig='.test-temp/visual-staging-standalone/gemma-150.jsonc'
$visionSamples=(Get-Content miniapp/cloudflare/visual_staging_samples.json -Raw|ConvertFrom-Json).products
$visionPrevious=Get-Content .test-temp/gemma-150-20261011/report.json -Raw|ConvertFrom-Json
$visionAudit=@{started_at=[DateTimeOffset]::UtcNow.ToString('o');cache_checks=@();attempt_started=$false;production_changed=$false}
$visionClient=$null;$visionKey=$null;$visionPhase='preflight';$visionSaveAllowed=$true
function Save-VisionAudit {
 [System.IO.File]::WriteAllText($visionOutput,($visionAudit|ConvertTo-Json -Depth 60),[System.Text.UTF8Encoding]::new($false))
}
function Invoke-VisionFinal([string]$path,$body=$null) {
 for($visionReadAttempt=0;$visionReadAttempt -lt 4;$visionReadAttempt++){
 $visionRequest=[System.Net.Http.HttpRequestMessage]::new($(if($null -eq $body){[System.Net.Http.HttpMethod]::Get}else{[System.Net.Http.HttpMethod]::Post}),$visionBase+$path)
 if($path -ne '/api/health'){$visionRequest.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$visionKey)}
 if($null -ne $body){$visionRequest.Content=[System.Net.Http.StringContent]::new(($body|ConvertTo-Json -Compress),[System.Text.Encoding]::UTF8,'application/json')}
 try {
  $visionResponse=$visionClient.SendAsync($visionRequest).GetAwaiter().GetResult()
  try {
   # A newly published staging session secret can take a few seconds to reach
   # all isolates. Only read-only 403 propagation checks may repeat.
   if($null -eq $body -and [int]$visionResponse.StatusCode -eq 403 -and $visionReadAttempt -lt 3){Start-Sleep -Seconds (3*($visionReadAttempt+1));continue}
   if(!$visionResponse.IsSuccessStatusCode){throw ('HTTP_'+[int]$visionResponse.StatusCode)}
   return ($visionResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json)
  } finally {$visionResponse.Dispose()}
 } finally {$visionRequest.Dispose()}
 }
}
try {
 if((& git branch --show-current) -ne 'codex/visual-staging-agent-20261010'){throw 'OWN_BRANCH_REQUIRED'}
 if((Get-Content $visionConfig -Raw) -notmatch '5779987d-1100-45ad-8cd4-9df9c1436a20'){throw 'STAGING_BOUNDARY_REQUIRED'}
 if(Test-Path $visionOutput){
  $visionEarlier=Get-Content $visionOutput -Raw|ConvertFrom-Json
  if($TryRemainingOnce -and $visionEarlier.attempt_started){$visionSaveAllowed=$false;throw 'SINGLE_REMAINING_ATTEMPT_ALREADY_USED'}
  $visionAudit.attempt_started=[bool]$visionEarlier.attempt_started
 }
 $visionClient=[System.Net.Http.HttpClient]::new();$visionClient.Timeout=[TimeSpan]::FromSeconds(55)
 $visionHealth=Invoke-VisionFinal '/api/health'
 if(!$visionHealth.staging -or $visionHealth.scheduled -or $visionHealth.database_id -ne '5779987d-1100-45ad-8cd4-9df9c1436a20'){throw 'STAGING_BOUNDARY_FAILED'}
 $env:XDG_CONFIG_HOME=Join-Path $visionRoot '.test-temp\config';$env:TEMP=Join-Path $visionRoot '.test-temp';$env:TMP=$env:TEMP
 $env:WRANGLER_SEND_METRICS='false';$env:WRANGLER_LOG='error';$env:WRANGLER_LOG_SANITIZE='true';$env:WRANGLER_LOG_PATH=Join-Path $visionRoot '.test-temp\vision-final.log'
 Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
 Remove-Item Env:CLOUDFLARE_API_KEY -ErrorAction SilentlyContinue
 $visionPhase='staging_session'
 $visionKey=[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 $visionCli=@($visionKey|& node node_modules/wrangler/bin/wrangler.js secret put MINIAPP_SYNC_KEY --config $visionConfig 2>&1)
 if($LASTEXITCODE -ne 0){throw 'STAGING_SESSION_FAILED'};$visionCli=$null
 $visionPhase='cache_verification'
 $visionAudit.before_status=Invoke-VisionFinal '/staging/status'
 $visionAudit.before_experiment=(Invoke-VisionFinal '/staging/experiment').experiment
 $visionAudit.before_profiles=(Invoke-VisionFinal '/staging/profiles').profiles
 if($visionAudit.before_status.enabled -or $visionAudit.before_status.automatic_analysis_allowed -or $visionAudit.before_status.river_mode -ne 'SHADOW' -or $visionAudit.before_status.budget_hold -or $visionAudit.before_experiment.hold -or $visionAudit.before_experiment.id -ne 'gemma-schema-20261011-150'){throw 'PREFLIGHT_SETTINGS_FAILED'}
 if(@($visionAudit.before_profiles).Count -lt 9){throw 'NINE_PERSISTED_PROFILES_REQUIRED'}
 foreach($visionSample in $visionSamples){
  $visionSaved=@($visionAudit.before_profiles|Where-Object {$_.images[0].hash -eq $visionSample.hash})
  if($visionSaved.Count -eq 0){continue}
  if($visionSaved.Count -ne 1){throw 'AMBIGUOUS_CACHE_HASH'}
  $visionOld=@($visionPrevious.all_profiles|Where-Object {$_.images[0].hash -eq $visionSample.hash})
  if($visionOld.Count -eq 1 -and ($visionOld[0]|ConvertTo-Json -Depth 50 -Compress) -cne ($visionSaved[0]|ConvertTo-Json -Depth 50 -Compress)){throw 'PERSISTED_PROFILE_CHANGED'}
  # The deployed route returns cachedProfiles BEFORE visualRun. Only verified
  # existing hashes enter this loop. There is no automatic POST retry.
  $visionCached=Invoke-VisionFinal '/staging/run' @{pid=$visionSample.id}
  if($visionCached.state -ne 'cached' -or ($visionCached.profile|ConvertTo-Json -Depth 50 -Compress) -cne ($visionSaved[0]|ConvertTo-Json -Depth 50 -Compress)){throw 'CACHE_READ_MISMATCH'}
  $visionAudit.cache_checks+=@{nmId=$visionSample.id;state='cached';same_profile=$true;d1=$visionCached.d1}
 }
 $visionAudit.cache_experiment=(Invoke-VisionFinal '/staging/experiment').experiment
 $visionAudit.cache_status=Invoke-VisionFinal '/staging/status'
 if($visionAudit.cache_experiment.calls -ne $visionAudit.before_experiment.calls -or $visionAudit.cache_experiment.charged -ne $visionAudit.before_experiment.charged -or $visionAudit.cache_status.calls_today -ne $visionAudit.before_status.calls_today -or $visionAudit.cache_status.neurons_charged -ne $visionAudit.before_status.neurons_charged){throw 'CACHE_EXTRA_AI_REFUSED'}
 Write-Output ('PERSISTED_PROFILES = '+@($visionAudit.before_profiles).Count+'; CACHE_CHECKS = '+@($visionAudit.cache_checks).Count+'; EXTRA_AI = 0')
 Save-VisionAudit
 if($TryRemainingOnce){
  $visionRemaining=$visionSamples|Where-Object {$_.id -eq 449731422}
  if(!($visionAudit.before_profiles|Where-Object {$_.images[0].hash -eq $visionRemaining.hash})){
   if($visionAudit.cache_experiment.calls -ne 2 -or $visionAudit.cache_experiment.limit -ne 150 -or $visionAudit.cache_experiment.reserve -ne 110 -or $visionAudit.cache_experiment.charged+110 -gt 150){throw 'REMAINING_BUDGET_REFUSED'}
   $visionPhase='remaining_single_attempt';$visionAudit.attempt_started=$true;Save-VisionAudit
   $visionAudit.remaining=Invoke-VisionFinal '/staging/run' @{pid=449731422}
   Write-Output ('REMAINING_PRODUCT = 449731422; STATE = '+$visionAudit.remaining.state)
  }
 }
 $visionPhase='final_reads'
 $visionAudit.final_profiles=(Invoke-VisionFinal '/staging/profiles').profiles
 $visionAudit.final_experiment=(Invoke-VisionFinal '/staging/experiment').experiment
 $visionAudit.final_status=Invoke-VisionFinal '/staging/status'
 if($visionAudit.final_experiment.charged -gt 150 -or $visionAudit.final_status.enabled -or $visionAudit.final_status.automatic_analysis_allowed -or $visionAudit.final_status.river_mode -ne 'SHADOW'){throw 'FINAL_SAFETY_CHECK_FAILED'}
} catch {
 # Transport classification only; never persist raw exception/provider bodies.
 $visionInner=$_.Exception;while($visionInner.InnerException){$visionInner=$visionInner.InnerException}
 $visionAudit.error=@{phase=$visionPhase;type=$visionInner.GetType().Name;code=$(if($_.Exception.Message -match '^([A-Z_]+|HTTP_\d{3})$'){$_.Exception.Message}else{'TLS_OR_TRANSPORT_FAILURE'});line=$_.InvocationInfo.ScriptLineNumber}
 Write-Output ('STOP_NO_RETRY = '+$visionAudit.error.code+'; PHASE = '+$visionPhase+'; TYPE = '+$visionAudit.error.type)
 # One read-only recovery snapshot, not a resend of any lost POST.
 if($visionKey){try{$visionAudit.final_profiles=(Invoke-VisionFinal '/staging/profiles').profiles;$visionAudit.final_experiment=(Invoke-VisionFinal '/staging/experiment').experiment;$visionAudit.final_status=Invoke-VisionFinal '/staging/status'}catch{}}
} finally {
 $visionAudit.finished_at=[DateTimeOffset]::UtcNow.ToString('o');if($visionSaveAllowed){Save-VisionAudit}
 $visionKey=$null;$visionCli=$null;if($visionClient){$visionClient.Dispose()}
 Write-Output ('FINAL_PROFILES = '+$(if($visionAudit.final_profiles){@($visionAudit.final_profiles).Count}else{'unconfirmed'})+'; EXPERIMENT_NEURONS = '+$visionAudit.final_experiment.charged+'; CALLS = '+$visionAudit.final_experiment.calls+'; AUTOMATIC_VISION = '+$visionAudit.final_status.enabled)
}
if($visionAudit.error){exit 1}
