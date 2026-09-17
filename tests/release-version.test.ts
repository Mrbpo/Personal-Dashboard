import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVersion,compareVersions,versionStatus} from '../lib/release-version.ts';
test('stable versions compare numerically, not lexicographically',()=>{
  assert.equal(compareVersions('v1.10.0','1.9.9'),1);
  assert.equal(compareVersions('1.0.0','v1.0.0'),0);
  assert.equal(compareVersions('0.9.9','1.0.0'),-1);
});
test('reject malformed, unsafe and prerelease versions',()=>{
  for(const value of ['1.0','v01.0.0','1.0.0-beta','1.0.0+build','9007199254740992.0.0','abc'])assert.equal(parseVersion(value),null);
  assert.throws(()=>versionStatus('local',[]));
});
test('ignore drafts, prereleases and non-semver tags; choose highest stable version',()=>{
  const items=[{tag_name:'v1.2.0',draft:false,prerelease:false},{tag_name:'v1.10.0',draft:false,prerelease:false},
    {tag_name:'v2.0.0',draft:true,prerelease:false},{tag_name:'v3.0.0',draft:false,prerelease:true},{tag_name:'latest',draft:false,prerelease:false}];
  assert.equal(versionStatus('1.9.0',items).latest,'v1.10.0');
  assert.equal(versionStatus('1.9.0',items).updateAvailable,true);
  assert.equal(versionStatus('1.10.0',items).status,'up-to-date');
  assert.equal(versionStatus('2.0.0',items).status,'ahead');
  assert.equal(versionStatus('1.0.0',[]).status,'no-release');
});
