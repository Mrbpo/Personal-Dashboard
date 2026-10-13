// Run inside the existing worker. Stdout is private input to the collector.
import { serviceValue } from '/app/lib/service-vault.ts';

try {
  const course = process.env.COURSE_VIDEO_COURSE_ID || '440904';
  const tool = process.env.COURSE_VIDEO_TOOL_ID || '8084';
  if (!/^[1-9][0-9]*$/.test(course) || !/^[1-9][0-9]*$/.test(tool)) throw new Error('INVALID_IDENTIFIERS');
  const base = new URL(process.env.CANVAS_BASE_URL || 'https://q.utoronto.ca');
  const expected = new URL(process.env.COURSE_VIDEO_CANVAS_ORIGIN || 'https://q.utoronto.ca');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' ||
      base.search || base.hash || base.origin !== expected.origin) throw new Error('INVALID_CANVAS_ORIGIN');
  const token = serviceValue('CANVAS_TOKEN');
  if (!token) throw new Error('CANVAS_TOKEN_NOT_CONFIGURED');
  const endpoint = new URL(`/api/v1/courses/${course}/external_tools/sessionless_launch`, base);
  endpoint.searchParams.set('id', tool);
  endpoint.searchParams.set('launch_type', 'course_navigation');
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`CANVAS_HTTP_${response.status}`);
  const data = JSON.parse((await response.text()).replace(/^\s*while\s*\(1\);\s*/, ''));
  const launch = new URL(data.url);
  if (launch.protocol !== 'https:' || launch.origin !== base.origin || launch.username || launch.password) {
    throw new Error('UNTRUSTED_LAUNCH_ORIGIN');
  }
  process.stdout.write(JSON.stringify({ launchUrl: launch.toString() }));
} catch (error) {
  const allowed = /^(INVALID_IDENTIFIERS|INVALID_CANVAS_ORIGIN|CANVAS_TOKEN_NOT_CONFIGURED|UNTRUSTED_LAUNCH_ORIGIN|CANVAS_HTTP_[0-9]{3})$/;
  const code = allowed.test(error?.message || '') ? error.message : 'GRANT_REQUEST_FAILED';
  process.stderr.write(JSON.stringify({ state: 'grant_failed', code }) + '\n');
  process.exitCode = 2;
}
