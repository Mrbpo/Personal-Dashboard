"""Offline administrator observation. Never edits a PDF or Docling export."""
from pathlib import Path
import argparse, hashlib, json, importlib.metadata, re
import pdfplumber

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['pdf','docling-export','owner','document-id','expected-pdf-sha256','out']:
        p.add_argument('--'+name,required=True)
    p.add_argument('--page',type=int,required=True)
    a=p.parse_args();pdf=Path(a.pdf);export=Path(a.docling_export)
    raw=pdf.read_bytes();source_hash=hashlib.sha256(raw).hexdigest()
    if source_hash!=a.expected_pdf_sha256:raise ValueError('Original PDF hash differs')
    exported=export.read_bytes();doc=json.loads(exported);origin=doc.get('origin',{})
    if origin.get('mimetype')!='application/pdf' or int(origin.get('binary_hash',-1))!=(int(source_hash,16)&((1<<64)-1)):
        raise ValueError('Docling original-input identity differs')
    with pdfplumber.open(pdf) as book:
        page=book.pages[a.page-1]
        if page.rotation or page.bbox!=(0,0,page.width,page.height):raise ValueError('Unsupported original page frame')
        chars=[{'index':i,'text':c['text'],'bbox':[c['x0'],c['top'],c['x1'],c['bottom']],'font':c['fontname']} for i,c in enumerate(page.chars)]
        regions=[]
        for i,table in enumerate(doc.get('tables',[])):
            prov=table.get('prov',[])
            if len(prov)!=1 or prov[0]['page_no']!=a.page:continue
            b=prov[0]['bbox']
            if b['coord_origin']=='BOTTOMLEFT':rect=[b['l'],page.height-b['t'],b['r'],page.height-b['b']]
            elif b['coord_origin']=='TOPLEFT':rect=[b['l'],b['t'],b['r'],b['b']]
            else:raise ValueError('Unknown region coordinate origin')
            selected=[]
            for c in chars:
                if not c['text'].strip():continue
                x0,y0,x1,y1=c['bbox'];l,t,r,bt=rect
                if x1<l or x0>r or y1<t or y0>bt:continue
                if not(l<=x0<=x1<=r and t<=y0<=y1<=bt):raise ValueError('Region cuts an original character')
                selected.append(c)
            text=page.crop(tuple(rect)).extract_text(layout=True,x_tolerance=2,y_tolerance=2)
            if not text or re.sub(r'\s','',text)!=re.sub(r'\s','',''.join(c['text'] for c in selected)):
                raise ValueError('Native region text changes original character sequence')
            regions.append({'id':f'table-{i}','bbox':rect,'text':text,'charIndices':[c['index'] for c in selected],
                'boundsReference':f'#/tables/{i}'})
        if not regions:raise ValueError('No eligible original regions')
        result={'policy':'native-pdf-region-observations-v1','source':{'owner':a.owner,'documentId':a.document_id,'sourceHash':source_hash,'pageCount':len(book.pages)},
            'producer':{'engine':'pdfplumber','packages':{k:importlib.metadata.version(k) for k in ['pdfplumber','pdfminer.six']},
                'options':{'layout':True,'x_tolerance':2,'y_tolerance':2},'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'boundsExportSha256':hashlib.sha256(exported).hexdigest(),'boundsAuthority':'parser-declared-untrusted'},
            'pages':[{'physicalPage':a.page,'width':page.width,'height':page.height,'chars':chars,'regions':regions}]}
    data=(json.dumps(result,ensure_ascii=False,indent=2)+'\n').encode()
    if len(data)>2*1024*1024:raise ValueError('Observation exceeds capacity')
    with Path(a.out).open('xb') as f:f.write(data)
    print(json.dumps({'sha256':hashlib.sha256(data).hexdigest(),'regions':len(regions),'bytes':len(data),'apiCalls':0}))

if __name__=='__main__':main()
