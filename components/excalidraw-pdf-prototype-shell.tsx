'use client';

import dynamic from 'next/dynamic';

const Prototype=dynamic(()=>import('./excalidraw-pdf-prototype').then(module=>module.ExcalidrawPdfPrototype),{ssr:false});

export function ExcalidrawPdfPrototypeShell(){return <Prototype/>;}
