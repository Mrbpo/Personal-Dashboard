import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sections, sectionHref, resolveSection, externalEntries, safeSourceHref } from '../lib/uiv2/sections.ts';

const source = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('all required console surfaces resolve with unique, same-origin navigation', () => {
  const keys = ['overview','tasks','courses','study','library','recordings','mail','health','ai-usage','settings','system'];
  assert.deepEqual(sections.map(section => section.key), keys);
  assert.equal(new Set(sections.map(section => sectionHref(section.key))).size, keys.length);
  assert.equal(resolveSection()?.section.key, 'overview');
  for (const section of sections) {
    assert.equal(resolveSection([section.key])?.section, section);
    assert.match(sectionHref(section.key), /^\/uiv2(?:\/[a-z-]+)?$/);
    assert.match(section.classic, /^\/(?!\/)/);
  }
  assert.deepEqual(externalEntries.map(entry => entry.href), ['/', '/hermes/', '/terminal/']);
  for (const entry of externalEntries) assert.match(entry.href, /^\/(?!\/)/);
});
test('unknown routes and unsupported tails are rejected, never silently mapped to overview', () => {
  for (const parts of [['missing'],['__proto__'],['constructor'],['study','x'],['library','x','y'],['settings','system'],['library','..'],['library','a/b'],['courses','a\\b'],['courses','\u0000']]) assert.equal(resolveSection(parts), null);
});
test('only existing reader and course detail routes get explicit encoded classic handoffs', () => {
  assert.equal(resolveSection(['library','doc-123'])?.classicDetail, '/library/doc-123');
  assert.equal(resolveSection(['courses','123'])?.classicDetail, '/courses/123');
  assert.equal(resolveSection(['library','空 格?#'])?.classicDetail, '/library/%E7%A9%BA%20%E6%A0%BC%3F%23');
  assert.equal(resolveSection(['mail'])?.classicDetail, null);
});
test('source evidence rejects executable, malformed and protocol-relative links', () => {
  for (const url of ['javascript:alert(1)','data:text/html,hello','//evil.test','file:///etc/passwd','not a URL','']) assert.equal(safeSourceHref(url), undefined);
  assert.equal(safeSourceHref(null), undefined);
  assert.equal(safeSourceHref('https://q.utoronto.ca/courses/1'), 'https://q.utoronto.ca/courses/1');
});
test('layout and page independently guard private content before loading data', () => {
  const layout = source('app/uiv2/layout.tsx');
  const page = source('app/uiv2/[[...section]]/page.tsx');
  assert.match(layout, /await requireOwnerPage\('\/uiv2'\)/);
  assert.match(layout, /authorized \? children/);
  assert.match(page, /await requireOwnerPage\(sectionHref\(section.key\)\)/);
  assert.ok(page.indexOf('if (!authorized) return null') < page.indexOf('await getSettings('));
  assert.ok(page.indexOf('if (!authorized) return null') < page.indexOf('await listCourseSettings('));
  assert.match(page, /if \(!resolved\) notFound\(\)/);
  assert.doesNotMatch(page, /import\(.*parts|from ['"].*page['"]/);
});
test('responsive navigation and scoped theme leave the root classic layout untouched', () => {
  const shell = source('components/uiv2/console-shell.tsx');
  const css = source('components/uiv2/console.module.css');
  assert.match(shell, /aria-expanded=\{open\}/);
  assert.match(shell, /aria-current=\{active === section.key \? 'page'/);
  assert.match(shell, /href="#uiv2-content"/);
  assert.match(css, /max-width: 800px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /vic3-theme|url\(|(?:^|\n)\s*(?:body|:root|html)\s*\{/);
  assert.match(css, /:global\(\.parchment-panel\)/);
  assert.match(css, /:global\(\.instrument-panel\)/);
  assert.doesNotMatch(css, /\.embedded \.instrument-panel/);
  assert.doesNotMatch(source('app/layout.tsx'), /uiv2/);
});
test('task actions retain the existing API contract and do not optimistically report success', () => {
  const dashboard = source('components/uiv2/dashboard.tsx');
  assert.match(dashboard, /status: 'completed', syncCanvas: true/);
  assert.match(dashboard, /if \(!response.ok\) throw new Error/);
  assert.match(dashboard, /dueWindow\(data\?\.tasks \|\| \[\], timezone, now\)/);
  assert.match(dashboard, /safeSourceHref\(task.sourceUrl\)/);
  assert.match(dashboard, /data && <>/);
});
