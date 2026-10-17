// Local research serializer only; structure checks do not certify source fidelity.
export const LIMITS = Object.freeze({tables:8, rows:100, columns:64, cells:2048, text:4096, caption:2048, uncertain:64});
const fail = message => { throw Error(message); };
const integer = (v,min,max) => Number.isSafeInteger(v) && v>=min && v<=max;
const shape = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const esc = text => text.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const boldKinds = ['all','none','mixed','uncertain'], headerKinds = ['none','row','column','section'];
export function validateAndSerialize(value) {
 if(!shape(value,['complete','uncertain','tables']) || typeof value.complete!=='boolean' || !Array.isArray(value.uncertain) ||
  value.uncertain.length>LIMITS.uncertain || value.uncertain.some(x=>typeof x!=='string'||x.length>1024) ||
  !Array.isArray(value.tables) || value.tables.length>LIMITS.tables) fail('Invalid structured-table envelope');
 const issues=[], html=[], search=[];
 for(const [ti,t] of value.tables.entries()) {
  if(!shape(t,['caption','rowCount','columnCount','cells']) || !(t.caption===null||typeof t.caption==='string'&&t.caption.length<=LIMITS.caption) ||
   !integer(t.rowCount,1,LIMITS.rows) || !integer(t.columnCount,1,LIMITS.columns) || !Array.isArray(t.cells) ||
   !t.cells.length || t.cells.length>LIMITS.cells) fail(`Invalid table ${ti}`);
  const grid=Array.from({length:t.rowCount},()=>Array(t.columnCount).fill(null)), starts=new Map(), local=[];
  for(const [ci,c] of t.cells.entries()) {
   if(!shape(c,['row','column','rowSpan','columnSpan','headerRole','text','bold']) ||
    !integer(c.row,0,LIMITS.rows-1) || !integer(c.column,0,LIMITS.columns-1) ||
    !integer(c.rowSpan,1,LIMITS.rows) || !integer(c.columnSpan,1,LIMITS.columns) ||
    !headerKinds.includes(c.headerRole) || !boldKinds.includes(c.bold) || typeof c.text!=='string' || c.text.length>LIMITS.text)
    fail(`Invalid cell ${ti}:${ci}`);
   search.push(`table=${ti} row=${c.row} column=${c.column} rowSpan=${c.rowSpan} columnSpan=${c.columnSpan} headerRole=${c.headerRole} bold=${c.bold} text=${JSON.stringify(c.text)}`);
   if(c.bold==='uncertain') issues.push(`table ${ti} cell ${ci}: uncertain bold style`);
   if(local.length) continue; // First geometry defect suffices; raw candidate stays unchanged.
   if(c.row+c.rowSpan>t.rowCount || c.column+c.columnSpan>t.columnCount) { local.push(`cell ${ci}: out of bounds`); continue; }
   const key=`${c.row}:${c.column}`;
   if(starts.has(key)) { local.push(`cell ${ci}: duplicate origin`); continue; } else starts.set(key,c);
   span: for(let r=c.row;r<c.row+c.rowSpan;r++) for(let col=c.column;col<c.column+c.columnSpan;col++) {
    if(grid[r][col]!==null) { local.push(`cell ${ci}: overlap at ${r}:${col}`); break span; } else grid[r][col]=ci;
   }
  }
  if(!local.length) missing: for(let r=0;r<t.rowCount;r++) for(let col=0;col<t.columnCount;col++)
   if(grid[r][col]===null) { local.push(`unprovided slot ${r}:${col}`); break missing; }
  if(t.caption!==null) search.push(`table=${ti} caption=${JSON.stringify(t.caption)}`);
  for(const x of local) issues.push(`table ${ti}: ${x}`);
  if(local.length) continue; // No invented cells, spans, blank fillers, or repaired grid.
  const rows=[];
  for(let r=0;r<t.rowCount;r++) {
   const cells=[];
   for(let col=0;col<t.columnCount;col++) {
    const c=starts.get(`${r}:${col}`); if(!c) continue;
    const tag=c.headerRole==='none'?'td':'th';
    const scope=c.headerRole==='column'?'col':c.headerRole==='row'?'row':null;
    const text=esc(c.text), body=c.bold==='all'?`<strong>${text}</strong>`:text;
    cells.push(`<${tag} data-row="${r}" data-column="${col}" data-header-role="${c.headerRole}" data-bold="${c.bold}" rowspan="${c.rowSpan}" colspan="${c.columnSpan}"${scope?` scope="${scope}"`:''}>${body}</${tag}>`);
   }
   rows.push(`<tr>${cells.join('')}</tr>`);
  }
  html.push(`<table data-table-index="${ti}">${t.caption===null?'':`<caption>${esc(t.caption)}</caption>`}<tbody>${rows.join('')}</tbody></table>`);
 }
 return {complete:value.complete && !value.uncertain.length && !issues.length, issues,
  uncertain:[...value.uncertain], html:issues.some(x=>!x.endsWith('uncertain bold style'))?null:html.join('\n'), searchText:search.join('\n')};
}
