// Production releases deliberately accept stable SemVer only.
export function parseVersion(value: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error('版本必须为 X.Y.Z 或 vX.Y.Z，正式发布不接受预发布版本');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export type PublishedRelease = {tag_name:string; draft:boolean; prerelease:boolean; published_at?:string; html_url?:string};
export function versionStatus(current: string, releases: PublishedRelease[]) {
  if (!parseVersion(current)) throw new Error('当前版本无法识别，不能判断更新');
  const latest = releases.filter(r => !r.draft && !r.prerelease && parseVersion(r.tag_name))
    .sort((a,b) => compareVersions(b.tag_name,a.tag_name))[0];
  if (!latest) return {status:'no-release', current, latest:null, updateAvailable:false};
  const comparison = compareVersions(latest.tag_name,current);
  return {status:comparison > 0 ? 'update-available' : comparison < 0 ? 'ahead' : 'up-to-date',
    current, latest:latest.tag_name, updateAvailable:comparison > 0,
    publishedAt:latest.published_at, url:latest.html_url};
}
