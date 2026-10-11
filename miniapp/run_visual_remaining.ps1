param([switch]$Deploy,[switch]$ResumeSessionFailure,[switch]$ResumeVerifiedCache)
$ErrorActionPreference='Stop'
$visionRoot='D:\WB-Vision-Agent';$visionDir=Join-Path $visionRoot '.test-temp\gemma-150-20261011'
$visionBase='https://wb-finds-visual-staging.valeramyakishev000.workers.dev'
$visionConfig='.test-temp/visual-staging-standalone/gemma-150.jsonc'
$visionReport=Join-Path $visionDir 'report.json'
$env:XDG_CONFIG_HOME=Join-Path $visionRoot '.test-temp\config';$env:TEMP=Join-Path $visionRoot '.test-temp';$env:TMP=$env:TEMP
$env:WRANGLER_SEND_METRICS='false';$env:WRANGLER_LOG='error';$env:WRANGLER_LOG_SANITIZE='true';$env:WRANGLER_LOG_PATH=Join-Path $visionRoot '.test-temp\gemma-150.log'
Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CLOUDFLARE_API_KEY -ErrorAction SilentlyContinue
$visionResults=@();$visionStatus=$null;$visionExperiment=$null;$visionStop='';$visionKey=$null;$visionHeaders=$null;$visionProfiles=@()
$visionPhase='preflight';$visionDiagnostic=$null
function Invoke-Vision([string]$path,$body=$null){
 # Use the same native Windows TLS client for reads and writes. PowerShell's
 # .NET TLS handshake failed before the experiment; this is not an AI retry.
 # A single POST, never retry after unknown transport outcome. Secrets/config
 # enter preinstalled curl through stdin, never arguments, files or logs.
 $visionJson=if($null -ne $body){($body|ConvertTo-Json -Compress).Replace('\','\\').Replace('"','\"')}else{$null}
 $visionCurlConfig=@(
  ('url = "'+$visionBase+$path+'"')
  $(if($null -ne $body){'request = "POST"'}else{'request = "GET"'})
  $(if($path -ne '/api/health'){('header = "Authorization: '+$visionHeaders.Authorization+'"')})
  'header = "Content-Type: application/json"'
  $(if($null -ne $body){('data = "'+$visionJson+'"')})
  'silent'
  'show-error'
  'fail-with-body'
  'max-time = 45'
  'ipv4'
  'write-out = "\n__STAGING_HTTP__%{http_code}"'
 )
 for($visionReadAttempt=0;$visionReadAttempt -lt 4;$visionReadAttempt++){
  $visionCurlOutput=@($visionCurlConfig|& curl.exe --config - 2>&1);$visionCurlExit=$LASTEXITCODE
  $visionWire=$visionCurlOutput -join "`n";$visionHttp=[regex]::Match($visionWire,'__STAGING_HTTP__(\d{3})$').Groups[1].Value
  # Only GET403 propagation reads are retryable. NEVER repeat a POST.
  if($null -eq $body -and $visionHttp -eq '403' -and $visionReadAttempt -lt 3){$visionCurlOutput=$null;$visionWire=$null;Start-Sleep -Seconds (3*($visionReadAttempt+1));continue}
  break
 }
 $visionCurlConfig=$null
 if($visionCurlExit -ne 0){$visionCurlOutput=$null;throw ('STAGING_HTTP_FAILED_'+$visionCurlExit)}
 $visionValue=($visionWire -replace '\n__STAGING_HTTP__\d{3}$','')|ConvertFrom-Json;$visionCurlOutput=$null;$visionWire=$null;return $visionValue
}
try{
 if((& git -C $visionRoot branch --show-current) -ne 'codex/visual-staging-agent-20261010'){throw 'OWN_BRANCH_REQUIRED'}
 if(!(Test-Path $visionDir)){New-Item -Path $visionDir -ItemType Directory|Out-Null}
 if(Test-Path $visionReport){
  $visionPrevious=Get-Content $visionReport -Raw|ConvertFrom-Json
  if($ResumeVerifiedCache){
   if($visionPrevious.experiment.hold -or $visionPrevious.status.budget_hold -or $visionPrevious.experiment.calls -ne 2 -or $visionPrevious.diagnostic.detail -ne 'STAGING_HTTP_FAILED_35'){throw 'UNVERIFIED_RECOVERY_REFUSED'}
   foreach($visionReceipt in $visionPrevious.experiment.calls_receipts){if($visionReceipt.outcome -ne 'provider_metered' -or $visionReceipt.diagnostic.validation -ne 'VALID_PROFILE' -or !($visionPrevious.all_profiles|Where-Object {$_.images[0].hash -eq $visionReceipt.image_hash})){throw 'UNVERIFIED_RECOVERY_REFUSED'}}
   $visionResults=@($visionPrevious.results)
  }elseif(!$ResumeSessionFailure -or @($visionPrevious.results).Count -gt 0 -or $visionPrevious.experiment.calls -gt 0 -or $visionPrevious.diagnostic.phase -ne 'staging_session'){throw 'EXISTING_RECEIPT_DO_NOT_REPEAT_TEST'}
 }
 if($Deploy){$visionCli=@(& node node_modules/wrangler/bin/wrangler.js deploy --config $visionConfig 2>&1);if($LASTEXITCODE -ne 0){throw 'STAGING_DEPLOY_FAILED'};$visionCli=$null;Write-Output 'ISOLATED_GEMMA_DEPLOY = OK'}
 $visionKey=[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 $visionPhase='staging_session'
 $visionCli=@($visionKey|& node node_modules/wrangler/bin/wrangler.js secret put MINIAPP_SYNC_KEY --config $visionConfig 2>&1);if($LASTEXITCODE -ne 0){
  $visionSafe=($visionCli -join "`n") -replace 'https?://\S+','[url]' -replace '(?i)(Bearer|token|secret|authorization|cookie)\s*[:=]?\s*\S+','[redacted]' -replace '[A-Za-z0-9_+/=-]{24,}','[opaque]'
  Write-Output ('STAGING_SESSION_ERROR = '+$visionSafe.Substring(0,[Math]::Min(400,$visionSafe.Length)));$visionCli=$null;throw 'STAGING_SESSION_FAILED'
 };$visionCli=$null
 $visionHeaders=@{Authorization='Bearer '+$visionKey}
 $visionHealth=Invoke-Vision '/api/health';if(!$visionHealth.staging -or $visionHealth.scheduled -or $visionHealth.database_id -ne '5779987d-1100-45ad-8cd4-9df9c1436a20'){throw 'STAGING_BOUNDARY_FAILED'}
 $visionPhase='experiment_init'
 $visionStatus=Invoke-Vision '/staging/status'
 $visionInit=Invoke-Vision '/staging/init/experiment' @{};if($visionInit.initialized -ne 'experiment'){throw 'EXPERIMENT_INIT_FAILED'}
 $visionExperiment=(Invoke-Vision '/staging/experiment').experiment
 if($visionStatus.model -ne '@cf/google/gemma-4-26b-a4b-it' -or $visionStatus.request_reserve -ne 110 -or $visionStatus.river_mode -ne 'SHADOW' -or $visionStatus.enabled -or $visionStatus.budget_hold -or $visionExperiment.id -ne 'gemma-schema-20261011-150' -or $visionExperiment.limit -ne 150 -or $visionExperiment.max_calls -ne 3){throw 'PREFLIGHT_FAILED'}
 if((!$ResumeVerifiedCache -and $visionExperiment.calls -gt 0) -or $visionExperiment.hold){throw 'EXISTING_AI_ATTEMPTS_DO_NOT_REPEAT'}
 Write-Output ('EXPERIMENT = '+$visionExperiment.id+'; limit=150; reserve=110; maximum_calls=3')
 $visionSamples=(Get-Content 'miniapp/cloudflare/visual_staging_samples.json' -Raw|ConvertFrom-Json).products|Where-Object {$_.id -in @(1113687154,1138890506,449731422)}
 foreach($visionSample in $visionSamples){
  if($visionSample.id -in @($visionResults|ForEach-Object nmId)){continue}
  $visionExisting=(Invoke-Vision '/staging/profiles').profiles|Where-Object {$_.images[0].hash -eq $visionSample.hash}
  if($visionExisting){
   # Recover only a proven completed D1 profile. No resend of the lost AI POST.
   $visionBefore=$visionExperiment.calls;$visionCached=Invoke-Vision '/staging/run' @{pid=$visionSample.id};$visionExperiment=(Invoke-Vision '/staging/experiment').experiment
   if($visionCached.state -ne 'cached' -or $visionExperiment.calls -ne $visionBefore){throw 'RECOVERY_CACHE_REQUIRED'}
   $visionResults+=@{nmId=$visionSample.id;title=$visionSample.title;image_url=$visionSample.image;image_file=($visionSample.id.ToString()+'.webp');state='cached';profile=$visionCached.profile;cache=$true;recovered_from_d1=$true;d1=$visionCached.d1}
   Write-Output ('PRODUCT = '+$visionSample.id+'; recovered_from_D1=True; cache=True; extra_AI=0');continue
  }
  if($visionExperiment.hold -or $visionExperiment.charged+110 -gt 150 -or $visionExperiment.calls -ge 3){$visionStop='BUDGET_STOP';break}
  $visionPhase='staging_product_'+$visionSample.id
  $visionResult=Invoke-Vision '/staging/run' @{pid=$visionSample.id}
  $visionStatus=Invoke-Vision '/staging/status';$visionExperiment=(Invoke-Vision '/staging/experiment').experiment
  $visionRow=@{nmId=$visionSample.id;title=$visionSample.title;image_url=$visionSample.image;image_file=($visionSample.id.ToString()+'.webp');state=$visionResult.state;error=$visionResult.error;profile=$visionResult.profile;cache=$false;d1=$visionResult.d1}
  if($visionResult.state -in @('complete','cached')){
   $visionCalls=$visionStatus.calls_today;$visionExperimentCalls=$visionExperiment.calls
   $visionRepeated=Invoke-Vision '/staging/run' @{pid=$visionSample.id}
   $visionAfter=Invoke-Vision '/staging/status';$visionExperiment=(Invoke-Vision '/staging/experiment').experiment
   $visionRow.cache=($visionRepeated.state -eq 'cached' -and $visionAfter.calls_today -eq $visionCalls -and $visionExperiment.calls -eq $visionExperimentCalls -and ($visionRepeated.profile|ConvertTo-Json -Depth 40 -Compress) -eq ($visionResult.profile|ConvertTo-Json -Depth 40 -Compress));$visionStatus=$visionAfter
  }
  $visionResults+=$visionRow
  [System.IO.File]::WriteAllText($visionReport,(@{results=$visionResults;status=$visionStatus;experiment=$visionExperiment;stop_reason='checkpoint'}|ConvertTo-Json -Depth 50),[System.Text.UTF8Encoding]::new($false))
  Write-Output ('PRODUCT = '+$visionSample.id+'; state='+$visionResult.state+'; error='+$visionResult.error+'; actual_neurons='+$visionExperiment.charged+'; fields='+@($visionResult.profile.fields.PSObject.Properties).Count+'; cache='+$visionRow.cache)
  if($visionResult.state -notin @('complete','cached') -or !$visionRow.cache){$visionStop='PROFILE_OR_CACHE_FAILED_NO_RETRY';break}
  if($visionExperiment.hold -or $visionStatus.budget_hold){$visionStop='COST_UNKNOWN_STOP';break}
 }
 $visionProfiles=(Invoke-Vision '/staging/profiles').profiles
}catch{
 $visionDetail=if($_.Exception.Message -match '^STAGING_HTTP_FAILED_\d{1,3}$'){$_.Exception.Message}else{($_.Exception.Message -replace 'https?://\S+','[url]' -replace '(?i)(Bearer|token|secret|authorization|cookie)\s*[:=]?\s*\S+','[redacted]' -replace '[A-Za-z0-9_+/=-]{24,}','[opaque]')}
 $visionDiagnostic=@{phase=$visionPhase;type=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;detail=$visionDetail}
 $visionStop=if($_.Exception.Message -match '^[A-Z_]+$'){$_.Exception.Message}else{'STAGING_OPERATION_FAILED_NO_RETRY'}
 if($visionHeaders){try{$visionStatus=Invoke-Vision '/staging/status';$visionExperiment=(Invoke-Vision '/staging/experiment').experiment;$visionProfiles=(Invoke-Vision '/staging/profiles').profiles}catch{}}
}
finally{
 if(Test-Path $visionDir){[System.IO.File]::WriteAllText($visionReport,(@{results=$visionResults;all_profiles=$visionProfiles;status=$visionStatus;experiment=$visionExperiment;stop_reason=$visionStop;diagnostic=$visionDiagnostic;finished_at=[DateTimeOffset]::UtcNow.ToString('o');production_changed=$false}|ConvertTo-Json -Depth 50),[System.Text.UTF8Encoding]::new($false))}
 $visionKey=$null;$visionHeaders=$null;$visionCli=$null
 Write-Output ('FINAL; new_profiles='+@($visionResults|Where-Object profile).Count+'; D1_profiles='+@($visionProfiles).Count+'; actual_neurons='+$visionExperiment.charged+'; stop='+$visionStop)
}
if($visionStop){exit 1}
