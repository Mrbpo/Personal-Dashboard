'use client';

import {useId,useState} from 'react';
import Link from 'next/link';
import {Button} from './ui/button';

export type StudyLibraryDocument={
 id:string;name:string;mime:string;status:string;error?:string|null;
 course_id?:string;course_code?:string;course_name?:string;
 origin?:string;folder_path?:string;document_types?:string[];
};
const sourceNames:Record<string,string>={canvas:'Canvas',quercus:'Canvas',piazza:'Piazza',gmail:'邮件',upload:'上传',kaltura:'课程录像',other:'其他来源'};
const typeNames:Record<string,string>={syllabus:'课程大纲',assignment:'作业与练习','lecture-notes':'讲义',slides:'课件',announcement:'公告',discussion:'讨论',transcript:'字幕与转写'};
const sourceOf=(document:StudyLibraryDocument)=>document.origin==='mail'?'gmail':document.origin==='quercus'?'canvas':document.origin||'other';
const courseOf=(document:StudyLibraryDocument)=>document.course_id||'unassigned';
const folderOf=(document:StudyLibraryDocument)=>document.folder_path||'未归档目录';
const typesOf=(document:StudyLibraryDocument)=>document.document_types?.length?document.document_types:['unclassified'];

export function StudyDocumentSidebar({documents,selectedIds,disabled,loading,libraryError,onSelectionChange}:{
 documents:StudyLibraryDocument[];selectedIds:string[];disabled:boolean;loading:boolean;libraryError:string;
 onSelectionChange:(ids:string[])=>void;
}){
 const panelId=useId(),[open,setOpen]=useState(false);
 const [query,setQuery]=useState(''),[course,setCourse]=useState('all'),[source,setSource]=useState('all');
 const [type,setType]=useState('all'),[folder,setFolder]=useState('all'),[selectedOnly,setSelectedOnly]=useState(false);
 const selected=new Set(selectedIds);
 const courses=[...new Map(documents.map(document=>[courseOf(document),document.course_code||document.course_name||document.course_id||'未绑定课程'])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
 const sources=[...new Set(documents.map(sourceOf))].sort();
 const types=[...new Set(documents.flatMap(typesOf))].sort();
 const folders=[...new Set(documents.map(folderOf))].sort((a,b)=>a.localeCompare(b));
 const term=query.trim().normalize('NFKC').toLocaleLowerCase();
 const visible=documents.filter(document=>(!selectedOnly||selected.has(document.id))&&
  (course==='all'||courseOf(document)===course)&&(source==='all'||sourceOf(document)===source)&&
  (type==='all'||typesOf(document).includes(type))&&(folder==='all'||folderOf(document)===folder)&&
  (!term||[document.name,document.course_code,document.course_name,document.folder_path].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase().includes(term)));
 const filtered=Boolean(query||course!=='all'||source!=='all'||type!=='all'||folder!=='all'||selectedOnly);
 const missing=selectedIds.filter(id=>!documents.some(document=>document.id===id));
 function reset(){setQuery('');setCourse('all');setSource('all');setType('all');setFolder('all');setSelectedOnly(false);}
 const selectClass='mt-1 w-full min-w-0 rounded-lg border bg-background px-2 py-2 text-sm';

 return <div className="min-h-0 min-w-0 border-b bg-muted/20 lg:h-full lg:border-r lg:border-b-0">
  <button type="button" className="flex w-full items-center justify-between p-4 text-left text-sm font-medium lg:hidden" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(!open)}>
   <span>PDF 资料库 · 已选 {selectedIds.length} 份</span><span aria-hidden="true">{open?'收起 −':'展开 ＋'}</span>
  </button>
  <aside id={panelId} aria-label="PDF 资料筛选" className={`${open?'flex':'hidden'} min-h-0 flex-col p-4 lg:flex lg:h-full`}>
   <div className="mb-4 flex items-center justify-between gap-2"><div><h2 className="font-semibold">PDF 资料库</h2><p className="mt-1 text-xs text-muted-foreground">已选 {selectedIds.length}/8 · 共 {documents.length} 份</p></div><Button asChild size="sm" variant="outline"><Link href="/library">管理</Link></Button></div>
   <div className="space-y-3">
    <label className="block text-xs font-medium">搜索 PDF<input aria-label="搜索 PDF" type="search" className={selectClass} value={query} onChange={event=>setQuery(event.target.value)} placeholder="文件名、课程或目录"/></label>
    <div className="grid grid-cols-2 gap-2">
     <label className="min-w-0 text-xs font-medium">课程<select aria-label="按课程筛选 PDF" className={selectClass} value={course} onChange={event=>setCourse(event.target.value)}><option value="all">全部课程</option>{courses.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
     <label className="min-w-0 text-xs font-medium">来源<select aria-label="按来源筛选 PDF" className={selectClass} value={source} onChange={event=>setSource(event.target.value)}><option value="all">全部来源</option>{sources.map(key=><option key={key} value={key}>{sourceNames[key]||key}</option>)}</select></label>
    </div>
    <div className="grid grid-cols-2 gap-2">
     <label className="min-w-0 text-xs font-medium">资料类型<select aria-label="按资料类型筛选 PDF" className={selectClass} value={type} onChange={event=>setType(event.target.value)}><option value="all">全部类型</option>{types.map(key=><option key={key} value={key}>{typeNames[key]||'未分类'}</option>)}</select></label>
     <label className="min-w-0 text-xs font-medium">目录<select aria-label="按目录筛选 PDF" className={selectClass} value={folder} onChange={event=>setFolder(event.target.value)}><option value="all">全部目录</option>{folders.map(key=><option key={key} value={key}>{key}</option>)}</select></label>
    </div>
    <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selectedOnly} onChange={event=>setSelectedOnly(event.target.checked)}/>只看已选</label>{filtered&&<button type="button" className="text-xs underline" onClick={reset}>重置筛选</button>}</div>
   </div>
   <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground"><span>显示 {visible.length} / {documents.length} 份</span>{selectedIds.length>0&&<button type="button" className="underline disabled:opacity-50" disabled={disabled} onClick={()=>onSelectionChange([])}>清空所选 PDF</button>}</div>
   <fieldset aria-label="可选 PDF 文件" disabled={disabled||!!libraryError} className="mt-2 max-h-[46dvh] min-h-0 space-y-1 overflow-y-auto overscroll-contain lg:max-h-none lg:flex-1">
    {visible.map(document=><label key={document.id} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${selected.has(document.id)?'border-primary/40 bg-primary/5':'border-transparent hover:bg-muted/50'}`}>
     <input className="mt-0.5 shrink-0" type="checkbox" checked={selected.has(document.id)} disabled={!selected.has(document.id)&&(document.status!=='ready'||selectedIds.length>=8)} onChange={event=>onSelectionChange(event.target.checked?[...selectedIds,document.id]:selectedIds.filter(id=>id!==document.id))}/>
     <span className="min-w-0"><span className="block break-words text-sm leading-5">{document.name}</span><span className="mt-1 block break-words text-[11px] text-muted-foreground">{document.course_code||document.course_id||'通用资料'} · {sourceNames[sourceOf(document)]||'其他来源'} · {document.status==='ready'?'已就绪':document.status==='error'?'解析失败':'正在解析'}</span>{document.error&&document.status!=='ready'&&<span className="mt-1 block break-words text-xs text-amber-800">{document.error}</span>}</span>
    </label>)}
    {loading&&<p className="py-4 text-sm text-muted-foreground">正在读取资料…</p>}
    {libraryError&&<p className="py-4 text-sm text-amber-800">{libraryError}</p>}
    {!loading&&!libraryError&&!documents.length&&<p className="py-4 text-sm text-muted-foreground">暂无 PDF，可先到资料库添加。</p>}
    {!loading&&!libraryError&&documents.length>0&&!visible.length&&<p className="py-4 text-sm text-muted-foreground">没有符合筛选的 PDF，请调整或重置筛选。</p>}
   </fieldset>
   {missing.length>0&&<p role="status" className="mt-3 text-xs text-amber-800">已选中 {missing.length} 份已不可用的资料，可清空后重新选择。</p>}
   <p className="mt-3 border-t pt-3 text-[11px] leading-5 text-muted-foreground">回答范围以勾选的 PDF 为准。</p>
  </aside>
 </div>;
}
