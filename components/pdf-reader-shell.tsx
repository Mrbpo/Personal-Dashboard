'use client';

import dynamic from 'next/dynamic';

const PdfReader=dynamic(()=>import('./pdf-reader').then(module=>module.PdfReader),{
  ssr:false,
  loading:()=> <div className="grid min-h-[60vh] place-items-center rounded-2xl border bg-muted/30 text-muted-foreground">正在启动阅读器…</div>,
});

export function PdfReaderShell({source,name,documentId}:{source:string;name:string;documentId:string}){
  return <PdfReader source={source} name={name} documentId={documentId}/>;
}
