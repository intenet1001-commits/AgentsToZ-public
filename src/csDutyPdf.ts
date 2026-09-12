import { runWithTimeout } from '../project-memory-server';

export const DUTY_PDF_BYTES = 50 * 1024 * 1024;
export class DutyPdfFailure extends Error {}
/** Fixed JXA program uses macOS PDFKit, with verified bytes on stdin. No shell, input
 * paths, PDF scripts, rendering, networking, or optional Homebrew dependency. */
const extractor = String.raw`
ObjC.import('Foundation'); ObjC.import('PDFKit');
function run() {
    var raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var encoded = $.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding);
    var data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
    var doc = $.PDFDocument.alloc.initWithData(data);
    if (!doc || doc.isNil()) return JSON.stringify({error:'invalid'});
    if (doc.isLocked || doc.isEncrypted) return JSON.stringify({error:'locked'});
    var count = Number(doc.pageCount), parts = [], bytes = 0;
    if (!count || count > 300) return JSON.stringify({error:'pages'});
    for (var i = 0; i < count; i++) {
        var text = ObjC.unwrap(doc.pageAtIndex(i).string) || '';
        if (!text.trim()) return JSON.stringify({error:'ocr',page:i+1});
        var block = '[PDF ' + (i+1) + '쪽]\n' + text.trim();
        bytes += Number($(block).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding)) + 2;
        if (bytes > 200000) return JSON.stringify({error:'size'});
        parts.push(block);
    }
    return JSON.stringify({body:parts.join('\n\n')});
}`;
export async function extractDutyPdf(bytes: Buffer, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (process.platform !== 'darwin') throw new DutyPdfFailure('PDF 텍스트 추출은 현재 macOS에서 지원합니다.');
    if (bytes.length > DUTY_PDF_BYTES) throw new DutyPdfFailure('PDF 파일은 50MiB 이하여야 합니다.');
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new DutyPdfFailure('올바른 PDF 파일이 아닙니다.');
    let result;
    try {
        result = await runWithTimeout(['/usr/bin/osascript', '-l', 'JavaScript', '-e', extractor], '/tmp', 15000, bytes.toString('base64'), { signal, maxOutputBytes: 512 * 1024 });
    } catch {
        signal.throwIfAborted();
        throw new DutyPdfFailure('PDF 텍스트를 추출하지 못했습니다. 파일을 확인한 뒤 다시 시도하세요.');
    }
    signal.throwIfAborted();
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new DutyPdfFailure('PDF 텍스트 추출에 실패했습니다. 파일을 확인하세요.'); }
    if (!value || typeof value !== 'object') throw new DutyPdfFailure('PDF 텍스트 추출 결과를 확인하지 못했습니다.');
    const errors: Record<string, string> = {
        invalid: 'PDF를 읽을 수 없습니다. 손상 여부를 확인하세요.', locked: '암호화된 PDF는 지원하지 않습니다. 암호 없는 사본을 선택하세요.',
        pages: 'PDF는 1~300쪽까지 지원합니다. 파일을 나누어 주세요.', size: '추출한 PDF 텍스트가 200KB를 넘습니다. 파일을 나누어 주세요.',
        ocr: '텍스트를 읽을 수 없는 페이지가 있습니다. 스캔·이미지 페이지는 OCR 처리 후 선택하세요. 빈 페이지도 제거해 주세요.',
    };
    if (result.exitCode !== 0 || typeof value.body !== 'string' || !value.body.trim() || Buffer.byteLength(value.body) > 200000 || value.body.includes('\0'))
        throw new DutyPdfFailure(errors[value.error] ?? 'PDF 텍스트 추출 결과를 확인하지 못했습니다.');
    return value.body;
}
