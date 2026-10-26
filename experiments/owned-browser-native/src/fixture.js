const role = document.body.dataset.role;
document.cookie = `account=${role}; SameSite=Strict; path=/`;
localStorage.setItem('account', role);
document.querySelector('#draft').value = `${role} initial draft`;
document.querySelector('#identity').textContent = `가상 계정: ${role} / 외부 서비스에 연결하지 않습니다.`;
window.probe = (epoch, barrier="initial") => {
  document.title = `ATZ:${JSON.stringify({role, epoch, barrier, cookie: document.cookie, storage: localStorage.getItem('account'), draft: document.querySelector('#draft').value, ua: navigator.userAgent, hostBridge: !!window.__TAURI_INTERNALS__ || !!window.__TAURI__ || !!window.ipc})}`;
};
window.probe(0);
