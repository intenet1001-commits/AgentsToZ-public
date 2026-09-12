import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutySources, readDutySourceFile } from '../src/csDutySources';
import { DutyKnowledge } from '../src/csDutyKnowledge';
import { extractDutyPdf } from '../src/csDutyPdf';
import { createCsDutyHost } from '../src/csDutyHost';
// A self-contained valid PDF fixture with a real text layer (no external generators).
function pdf(text: string, padding = 0) {
    const stream = (text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : '') + (padding ? '\n%'+'x'.repeat(padding) : '');
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let body='%PDF-1.4\n',offsets=[0];
    for(const [i,object] of objects.entries()){offsets.push(body.length);body+=`${i+1} 0 obj\n${object}\nendobj\n`;}
    const xref=body.length;body+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(body);
}
test.skipIf(process.platform!=='darwin')('PDFKit extracts real PDF into both document pickers and reviewed source bodies',async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'duty-pdf-')));
    try {
        await writeFile(join(root,'guide.pdf'),pdf('Support hours are 9 to 5.'));
        const sources=new DutySources(async()=>root,async()=>null), signal=new AbortController().signal;
        const result=await sources.collect('project-123',false,signal);
        expect(result.catalog.sources.map(s=>s.title)).toEqual(['guide.pdf']);
        expect([...result.bodies.values()][0]?.body).toContain('[PDF 1쪽]');
        expect([...result.bodies.values()][0]?.body).toContain('Support hours');
        const k=new DutyKnowledge(root,sources,async()=>root,()=>Date.now());
        try {
            const selected=result.catalog.sources.map(s=>({id:s.id,hash:s.hash}));
            k.prepare('project-123',selected,false,0,'chat_pdf');
            for(let n=0;n<1000&&k.job('project-123')?.state==='building';n++)await Bun.sleep(5);
            const candidate=k.job('project-123')?.candidate;
            expect(candidate).toBeDefined();
            const approved=await k.apply('project-123',candidate!.id,candidate!.manifestHash,0,'chat_pdf');
            expect(k.search('project-123','chat_pdf',approved.snapshotId,'Support hours')[0]?.body).toContain('9 to 5');
            await writeFile(join(root,'guide.pdf'),pdf('Support hours are 10 to 6.'));
            expect((await k.updates('project-123',signal)).changed).toEqual(['guide.pdf']);
            expect(k.search('project-123','chat_pdf',approved.snapshotId,'Support hours')[0]?.body).toContain('9 to 5');
        } finally {await k.shutdown();}
        const h=createCsDutyHost(root,async()=>root,async()=>root);
        expect((await h.documents('project-123')).map(d=>d.path)).toContain('guide.pdf');
        expect(await h.documentText('project-123',['guide.pdf'])).toContain('Support hours');
        await writeFile(join(root,'scan.pdf'),pdf(''));
        const updated=await sources.collect('project-123',false,signal);
        expect(updated.catalog.warnings.join()).toContain('OCR');
        expect(updated.catalog.sources.filter(s=>!s.unavailable).length).toBe(1);
        expect(updated.catalog.sources.find(s=>s.title==='scan.pdf')?.unavailable).toBe(true);
        await expect(h.documentText('project-123',['scan.pdf'])).rejects.toThrow('OCR');
        await symlink(join(root,'guide.pdf'),join(root,'link.pdf'));
        await expect(readDutySourceFile(root,'link.pdf',signal)).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
},30000);
test('PDF input and cancellation are bounded before extraction',async()=>{
    const signal=AbortSignal.abort();await expect(extractDutyPdf(pdf('hello'),signal)).rejects.toThrow();
    if(process.platform==='darwin') {
        await expect(extractDutyPdf(Buffer.from('not pdf'),new AbortController().signal)).rejects.toThrow('PDF');
        await expect(extractDutyPdf(Buffer.alloc(50*1024*1024+1),new AbortController().signal)).rejects.toThrow('50MiB');
    }
});

test.skipIf(process.platform!=='darwin')('a 12.5 MiB PDF is accepted without relaxing extracted text bounds',async()=>{
    const bytes=pdf('Readable large PDF',Math.ceil(12.5*1024*1024));
    expect(await extractDutyPdf(bytes,AbortSignal.timeout(15000))).toContain('Readable large PDF');
},20000);
