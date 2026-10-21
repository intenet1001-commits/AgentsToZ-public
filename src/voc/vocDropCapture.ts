/**
 * VOC 모드가 켜져 있는 동안 앱의 Tauri 파일 드롭을 VOC가 가져간다.
 *
 * Tauri의 `onDragDropEvent`는 DOM 이벤트가 아니라 **모든 리스너에게 동시에** 전달된다.
 * 그래서 `stopPropagation`에 해당하는 것이 없고, VOC 폼 아래에 `FolderDropZone`이 깔려
 * 있으면 스크린샷 한 장을 떨어뜨리는 것이 곧 「프로젝트 추가」가 된다. VOC 오버레이는
 * 앱 전체를 덮으므로(실제 동작은 일어나지 않는다고 배너가 말한다), 켜져 있는 동안에는
 * 다른 드롭 표면이 반응하지 않는 것이 맞다. 오버레이가 마운트되면 참, 풀리면 거짓.
 */
let captureDepth = 0;

export function beginVocDropCapture(): () => void {
  captureDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    captureDepth = Math.max(0, captureDepth - 1);
  };
}

export function isVocDropCaptureActive(): boolean {
  return captureDepth > 0;
}
