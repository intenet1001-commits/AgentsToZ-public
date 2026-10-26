import type {Lang} from './i18n';
import {BROWSER_ERROR_CODES,type BrowserErrorCode} from './workroomBrowserErrorCodes';

export {BROWSER_ERROR_CODES,type BrowserErrorCode};

export const BROWSER_LOAD_ERROR_CODES=[
 'load-refused',
 'load-timeout',
 'load-name-not-resolved',
 'load-offline',
 'load-certificate',
] as const;

export type BrowserLoadErrorCode=(typeof BROWSER_LOAD_ERROR_CODES)[number];

export type BrowserPageErrorCardCopy={
 readonly title:string;
 readonly cause:string;
 readonly tryHeading:string;
 readonly tryList:readonly [string,string,string];
 readonly retry:string;
 readonly editAddress:string;
};

export type BrowserPageErrorCopy={
 readonly title:string;
 readonly offlineTitle:string;
 readonly tryHeading:string;
 readonly tryServer:string;
 readonly tryAddress:string;
 readonly tryNetwork:string;
 readonly tryList:readonly [string,string,string];
 readonly retry:string;
 readonly editAddress:string;
 readonly cards:Readonly<Record<BrowserLoadErrorCode,BrowserPageErrorCardCopy>>;
};

export const workroomBrowserErrorMessages:Record<Lang,Record<BrowserErrorCode,string>>={
 ko:{
  'workspace-not-found':'열려 있는 브라우저 작업을 찾지 못했습니다. 페이지를 다시 열어 주세요.',
  'session-ended':'이 워크룸 대화창이 종료되었습니다. 새 워크룸에서 브라우저를 열어 주세요.',
  'chrome-disconnected':'Chrome 연결이 끊겼습니다. 다시 연결해 주세요.',
  'queue-full':'대기 중인 브라우저 동작이 너무 많습니다. 진행 중인 동작이 끝난 뒤 다시 시도해 주세요.',
  'observe-failed':'페이지 내용을 제때 읽지 못했습니다. 페이지를 새로 고치거나 다시 시도해 주세요.',
  'approval-pending':'다른 브라우저 연결을 마무리하는 중입니다. 잠시 후 다시 시도해 주세요.',
  'profile-mismatch':'현재 열린 브라우저 프로필과 일치하지 않습니다. 지금 브라우저를 닫은 뒤 다시 연결해 주세요.',
  'tab-limit':'한 작업에는 탭을 최대 6개까지 둘 수 있습니다. 쓰지 않는 탭을 닫은 뒤 추가해 주세요.',
  'tab-not-in-set':'이 작업에 연결된 탭이 아닙니다. 탭 목록에서 사용할 탭을 다시 골라 주세요.',
  'stale-observation':'페이지 화면이 바뀌어 이전 위치 정보가 만료되었습니다. 화면을 다시 확인한 뒤 진행해 주세요.',
  'take-control-first':'지금은 자동 작업이 브라우저를 사용 중입니다. 「직접 하기」를 누른 뒤 조작해 주세요.',
  'popup-open':'로그인 창이 열려 있어 제어권을 넘길 수 없습니다. 로그인을 마치고 창을 닫은 뒤 다시 시도해 주세요.',
  'invalid-address':'열 수 있는 웹 주소 형식이 아닙니다. 주소를 확인하고 다시 입력해 주세요.',
  'profile-timeout':'브라우저 준비 시간이 초과되었습니다. 잠시 후 다시 열어 주세요.',
  'still-closing':'이전 브라우저 창을 닫는 중입니다. 잠시 후 다시 열어 주세요.',
  'profile-in-use':'이 브라우저 프로필은 다른 워크룸에서 이미 열려 있습니다. 그 워크룸의 브라우저를 먼저 닫아 주세요.',
  'workroom-limit':'동시에 열 수 있는 브라우저 작업 수(4개)를 넘었습니다. 다른 워크룸의 브라우저를 닫은 뒤 다시 시도해 주세요.',
  'other-window':'이 브라우저 화면은 다른 워크룸 창에 연결되어 있습니다. 원래 창에서 계속 조작해 주세요.',
  'embedded-unavailable':'이 기기에서는 내장 브라우저를 실행할 수 없습니다. 「내 Chrome」으로 연결해 계속해 주세요.',
  'workspace-changed':'브라우저 연결 상태가 바뀌었습니다. 페이지를 다시 확인하거나 다시 연결해 주세요.',
  'grant-unavailable':'브라우저 접근 권한을 준비하지 못했습니다. 「직접 하기」를 누른 뒤 다시 넘겨 주세요.',
  'reload-would-resubmit':'이전 양식이 다시 제출될 수 있어 새로 고치지 않았습니다. 주소창에서 주소로 다시 열어 주세요.',
  'target-lost':'열린 페이지와 연결이 일시적으로 끊겼습니다. 페이지는 그대로 두고 「연결 다시 시도」를 눌러 주세요.',
  'load-refused':'{host}에서 연결을 거부했습니다. 개발 서버가 실행 중인지 확인해 주세요.',
  'load-timeout':'{host} 응답이 너무 늦습니다. 개발 서버가 실행 중인지 확인해 주세요.',
  'load-name-not-resolved':'{host} 주소를 찾지 못했습니다. 주소 철자와 네트워크 연결을 확인해 주세요.',
  'load-offline':'네트워크에 연결되어 있지 않습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
  'load-certificate':'{host} 보안 인증서를 확인하지 못했습니다. 주소를 확인하거나 안전한 페이지로 이동해 주세요.',
  generic:'브라우저 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
 },
 en:{
  'workspace-not-found':'Could not find an open browser task. Open the page again.',
  'session-ended':'This task session has ended. Open the browser in an active session.',
  'chrome-disconnected':'Chrome disconnected. Reconnect to continue.',
  'queue-full':'Too many browser actions are waiting in line. Wait for them to finish and try again.',
  'observe-failed':'The page did not respond in time while reading its content. Reload or try again.',
  'approval-pending':'Finishing another browser connection. Try again in a moment.',
  'profile-mismatch':'The selected profile does not match the open browser. Close the current browser and reconnect.',
  'tab-limit':'A task can hold up to 6 tabs. Close an unused tab before adding another.',
  'tab-not-in-set':'That tab is no longer attached to this task. Pick an open tab from the tab bar.',
  'stale-observation':'The page changed since it was last read. Refresh the page view before continuing.',
  'take-control-first':'The assistant is currently in control. Press Take over before changing the page or tabs.',
  'popup-open':'A sign-in window is still open. Finish signing in and close that window before handing over.',
  'invalid-address':'That address cannot be opened here. Enter a valid web address and try again.',
  'profile-timeout':'The browser took too long to start. Wait a moment and open the page again.',
  'still-closing':'The previous browser session is still closing. Wait a moment and try again.',
  'profile-in-use':'This browser profile is already open in another task. Close it there before opening it here.',
  'workroom-limit':'Four browser tasks are already open at once. Close a browser in another task and try again.',
  'other-window':'This browser belongs to another window. Continue working in that window.',
  'embedded-unavailable':'The built-in browser is not available on this device. Connect My Chrome to continue.',
  'workspace-changed':'The browser connection state changed. Check the page or reconnect before continuing.',
  'grant-unavailable':'Could not prepare browser access. Take over and hand the page to the assistant again.',
  'reload-would-resubmit':'Reloading would resubmit a form, so it was skipped. Reopen the address from the address bar instead.',
  'target-lost':'Lost connection to the open page. Keep the page open and press Retry connection.',
  'load-refused':'{host} refused to connect. Check whether the local dev server is running.',
  'load-timeout':'{host} took too long to respond. Check whether the local dev server is running.',
  'load-name-not-resolved':'Could not find the address for {host}. Check the address spelling and your network.',
  'load-offline':'You are not connected to the network. Check your internet connection and try again.',
  'load-certificate':'Could not verify the security certificate for {host}. Check the address or open a trusted page.',
  generic:'Could not complete the browser request. Try again in a moment.',
 },
 ja:{
  'workspace-not-found':'開いているブラウザ作業が見つかりませんでした。ページをもう一度開いてください。',
  'session-ended':'このワークルームのセッションは終了しました。新しいワークルームでブラウザを開いてください。',
  'chrome-disconnected':'Chromeとの接続が切れました。もう一度接続してください。',
  'queue-full':'待機中のブラウザ操作が多すぎます。現在の操作が終わってからもう一度お試しください。',
  'observe-failed':'ページの内容を時間内に読み取れませんでした。再読み込みするか、もう一度お試しください。',
  'approval-pending':'別のブラウザ接続を終了しています。少し待ってからもう一度お試しください。',
  'profile-mismatch':'現在開いているブラウザのプロファイルと一致しません。現在のブラウザを閉じてから再接続してください。',
  'tab-limit':'1つの作業にはタブを6つまで置けます。使っていないタブを閉じてから追加してください。',
  'tab-not-in-set':'この作業に接続されているタブではありません。タブ一覧から使うタブを選び直してください。',
  'stale-observation':'ページの内容が変わったため、前の読み取り情報が古くなりました。画面を再確認してから続けてください。',
  'take-control-first':'現在は自動作業がブラウザを操作しています。「自分で操作」を押してから操作してください。',
  'popup-open':'ログイン画面が開いているため引き継げません。ログインを終えて画面を閉じてからもう一度お試しください。',
  'invalid-address':'開ける形式のウェブアドレスではありません。アドレスを確認してもう一度入力してください。',
  'profile-timeout':'ブラウザの準備が時間切れになりました。少し待ってからもう一度開いてください。',
  'still-closing':'前のブラウザを閉じています。少し待ってからもう一度開いてください。',
  'profile-in-use':'このブラウザプロファイルは別のワークルームですでに開いています。先にそちらのブラウザを閉じてください。',
  'workroom-limit':'同時に開けるブラウザ作業の上限（4件）に達しました。ほかのワークルームのブラウザを閉じてからもう一度お試しください。',
  'other-window':'このブラウザ画面は別のワークルームウィンドウに接続されています。元のウィンドウで操作を続けてください。',
  'embedded-unavailable':'このデバイスでは内蔵ブラウザを起動できません。「マイChrome」に接続して続けてください。',
  'workspace-changed':'ブラウザの接続状態が変わりました。ページを確認するか、もう一度接続してください。',
  'grant-unavailable':'ブラウザのアクセス権を準備できませんでした。「自分で操作」を押してからもう一度引き継いでください。',
  'reload-would-resubmit':'フォームが再送信される恐れがあるため再読み込みを止めました。アドレス欄から開き直してください。',
  'target-lost':'開いているページとの接続が一時的に切れました。ページはそのままにして「接続を再試行」を押してください。',
  'load-refused':'{host} が接続を拒否しました。開発サーバーが起動しているか確認してください。',
  'load-timeout':'{host} の応答が時間切れになりました。開発サーバーが起動しているか確認してください。',
  'load-name-not-resolved':'{host} のアドレスが見つかりませんでした。綴りとネットワーク接続を確認してください。',
  'load-offline':'ネットワークに接続されていません。インターネット接続を確認してからもう一度お試しください。',
  'load-certificate':'{host} のセキュリティ証明書を確認できませんでした。アドレスを確認するか、安全なページを開いてください。',
  generic:'ブラウザの操作を完了できませんでした。少し待ってからもう一度お試しください。',
 },
 'zh-CN':{
  'workspace-not-found':'未找到已打开的浏览器任务。请重新打开页面。',
  'session-ended':'此工作室会话已结束。请在新的工作室中打开浏览器。',
  'chrome-disconnected':'Chrome 连接已断开。请重新连接。',
  'queue-full':'排队等待的浏览器操作过多。请等当前操作完成后再试。',
  'observe-failed':'未能及时读取页面内容。请刷新页面或重试。',
  'approval-pending':'正在结束另一个浏览器连接。请稍后再试。',
  'profile-mismatch':'所选配置文件与当前打开的浏览器不一致。请先关闭当前浏览器再重新连接。',
  'tab-limit':'一个任务最多可保留 6 个标签页。请先关闭不用的标签页再添加。',
  'tab-not-in-set':'该标签页未连接到此任务。请从标签页栏中重新选择。',
  'stale-observation':'页面内容已变化，先前的页面信息已过期。请重新读取页面后再继续。',
  'take-control-first':'当前正在自动操作浏览器。请先点击“直接操作”再进行更改。',
  'popup-open':'登录窗口仍处于打开状态。请先完成登录并关闭该窗口，然后再试。',
  'invalid-address':'这不是可打开的网页地址格式。请检查地址后重新输入。',
  'profile-timeout':'浏览器准备超时。请稍后再重新打开页面。',
  'still-closing':'正在关闭上一次的浏览器窗口。请稍后再试。',
  'profile-in-use':'此浏览器配置文件已在另一个工作室中打开。请先关闭那里的浏览器。',
  'workroom-limit':'同时打开的浏览器任务已达上限（4 个）。请先关闭其他工作室中的浏览器再试。',
  'other-window':'此浏览器画面已绑定到另一个工作室窗口。请在原窗口中继续操作。',
  'embedded-unavailable':'此设备无法启动内置浏览器。请连接“我的 Chrome”继续使用。',
  'workspace-changed':'浏览器连接状态已变更。请确认页面或重新连接后再继续。',
  'grant-unavailable':'未能准备好浏览器访问权限。请先点击“直接操作”，再重新交接。',
  'reload-would-resubmit':'刷新会导致重复提交表单，已取消操作。请从地址栏按地址重新打开。',
  'target-lost':'与已打开页面的连接暂时中断。请保持页面打开并点击“重试连接”。',
  'load-refused':'{host} 拒绝了连接请求。请检查本地开发服务器是否正在运行。',
  'load-timeout':'{host} 响应超时。请检查本地开发服务器是否正在运行。',
  'load-name-not-resolved':'找不到 {host} 的地址。请检查地址拼写和网络连接。',
  'load-offline':'当前未连接到网络。请检查互联网连接后重试。',
  'load-certificate':'无法验证 {host} 的安全证书。请检查地址或打开受信任的页面。',
  generic:'未能完成浏览器请求。请稍后再试。',
 },
 es:{
  'workspace-not-found':'No se encontró ninguna tarea abierta del navegador. Vuelve a abrir la página.',
  'session-ended':'Esta sesión de trabajo ha terminado. Abre el navegador en una sesión activa.',
  'chrome-disconnected':'Se desconectó Chrome. Vuelve a conectarlo para continuar.',
  'queue-full':'Hay demasiadas acciones del navegador en espera. Espera a que terminen e inténtalo de nuevo.',
  'observe-failed':'La página no respondió a tiempo al leer su contenido. Recárgala o inténtalo de nuevo.',
  'approval-pending':'Se está cerrando otra conexión del navegador. Inténtalo de nuevo en un momento.',
  'profile-mismatch':'El perfil elegido no coincide con el navegador abierto. Cierra el navegador actual y vuelve a conectar.',
  'tab-limit':'Una tarea admite hasta 6 pestañas. Cierra una pestaña que no uses antes de añadir otra.',
  'tab-not-in-set':'Esa pestaña ya no está vinculada a esta tarea. Elige una pestaña abierta en la barra.',
  'stale-observation':'La página cambió desde la última lectura. Vuelve a revisar la página antes de continuar.',
  'take-control-first':'El asistente tiene el control en este momento. Pulsa Tomar el control antes de cambiar la página.',
  'popup-open':'Hay una ventana de inicio de sesión abierta. Termina de iniciar sesión y ciérrala antes de continuar.',
  'invalid-address':'Esa dirección no tiene un formato válido. Revisa la dirección e inténtalo de nuevo.',
  'profile-timeout':'El navegador tardó demasiado en iniciarse. Espera un momento y vuelve a abrir la página.',
  'still-closing':'El navegador anterior aún se está cerrando. Espera un momento e inténtalo de nuevo.',
  'profile-in-use':'Este perfil del navegador ya está abierto en otra tarea. Ciérralo allí antes de abrirlo aquí.',
  'workroom-limit':'Ya hay cuatro tareas de navegador abiertas a la vez. Cierra el navegador de otra tarea e inténtalo de nuevo.',
  'other-window':'Este navegador pertenece a otra ventana. Continúa trabajando desde esa ventana.',
  'embedded-unavailable':'El navegador integrado no está disponible en este dispositivo. Conecta Mi Chrome para continuar.',
  'workspace-changed':'El estado de conexión del navegador cambió. Revisa la página o vuelve a conectar antes de seguir.',
  'grant-unavailable':'No se pudo preparar el acceso al navegador. Toma el control y vuelve a entregar la página.',
  'reload-would-resubmit':'Recargar volvería a enviar un formulario, por lo que se detuvo. Abre de nuevo la dirección desde la barra.',
  'target-lost':'Se perdió temporalmente la conexión con la página abierta. Déjala abierta y pulsa Reintentar conexión.',
  'load-refused':'{host} rechazó la conexión. Comprueba si el servidor de desarrollo está en marcha.',
  'load-timeout':'{host} tardó demasiado en responder. Comprueba si el servidor de desarrollo está en marcha.',
  'load-name-not-resolved':'No se pudo encontrar la dirección de {host}. Revisa cómo está escrita y tu conexión de red.',
  'load-offline':'No hay conexión a la red. Comprueba tu conexión e inténtalo de nuevo.',
  'load-certificate':'No se pudo verificar el certificado de seguridad de {host}. Revisa la dirección o abre una página segura.',
  generic:'No se pudo completar la acción del navegador. Inténtalo de nuevo en un momento.',
 },
 fr:{
  'workspace-not-found':'Aucune tâche ouverte du navigateur n’a été trouvée. Rouvrez la page.',
  'session-ended':'Cette session de travail est terminée. Ouvrez le navigateur dans une session active.',
  'chrome-disconnected':'Chrome a été déconnecté. Reconnectez-vous pour continuer.',
  'queue-full':'Trop d’actions du navigateur sont en attente. Patientez jusqu’à leur fin puis réessayez.',
  'observe-failed':'La page n’a pas répondu à temps lors de la lecture. Actualisez-la ou réessayez.',
  'approval-pending':'Une autre connexion du navigateur se termine. Réessayez dans un instant.',
  'profile-mismatch':'Le profil choisi ne correspond pas au navigateur ouvert. Fermez le navigateur actuel puis reconnectez-vous.',
  'tab-limit':'Une tâche peut contenir jusqu’à 6 onglets. Fermez un onglet inutilisé avant d’en ajouter un autre.',
  'tab-not-in-set':'Cet onglet n’est plus rattaché à cette tâche. Choisissez un onglet ouvert dans la barre.',
  'stale-observation':'La page a changé depuis la dernière lecture. Relisez la page avant de continuer.',
  'take-control-first':'L’assistant a actuellement la main. Appuyez sur Prendre la main avant de modifier la page.',
  'popup-open':'Une fenêtre de connexion est encore ouverte. Terminez la connexion et fermez-la avant de continuer.',
  'invalid-address':'Cette adresse n’a pas un format valide. Vérifiez l’adresse puis réessayez.',
  'profile-timeout':'Le navigateur a mis trop de temps à démarrer. Patientez un instant puis rouvrez la page.',
  'still-closing':'Le navigateur précédent est encore en train de se fermer. Patientez un instant puis réessayez.',
  'profile-in-use':'Ce profil de navigateur est déjà ouvert dans une autre tâche. Fermez-le là-bas avant de l’ouvrir ici.',
  'workroom-limit':'Quatre tâches de navigateur sont déjà ouvertes en même temps. Fermez le navigateur d’une autre tâche puis réessayez.',
  'other-window':'Ce navigateur appartient à une autre fenêtre. Continuez à travailler dans cette fenêtre-là.',
  'embedded-unavailable':'Le navigateur intégré n’est pas disponible sur cet appareil. Connectez Mon Chrome pour continuer.',
  'workspace-changed':'L’état de connexion du navigateur a changé. Vérifiez la page ou reconnectez-vous avant de continuer.',
  'grant-unavailable':'Impossible de préparer l’accès au navigateur. Prenez la main puis confiez de nouveau la page.',
  'reload-would-resubmit':'L’actualisation renverrait un formulaire et a été annulée. Rouvrez plutôt l’adresse depuis la barre.',
  'target-lost':'La connexion avec la page ouverte a été interrompue. Gardez la page ouverte et appuyez sur Relancer la connexion.',
  'load-refused':'{host} a refusé la connexion. Vérifiez si le serveur de développement est lancé.',
  'load-timeout':'{host} a mis trop de temps à répondre. Vérifiez si le serveur de développement est lancé.',
  'load-name-not-resolved':'Impossible de trouver l’adresse de {host}. Vérifiez l’orthographe de l’adresse et votre réseau.',
  'load-offline':'Aucune connexion au réseau. Vérifiez votre connexion puis réessayez.',
  'load-certificate':'Impossible de vérifier le certificat de sécurité de {host}. Vérifiez l’adresse ou ouvrez une page fiable.',
  generic:'Impossible de terminer l’action du navigateur. Réessayez dans un instant.',
 },
 de:{
  'workspace-not-found':'Keine geöffnete Browser-Aufgabe gefunden. Öffnen Sie die Seite erneut.',
  'session-ended':'Diese Arbeitssitzung wurde beendet. Öffnen Sie den Browser in einer aktiven Sitzung.',
  'chrome-disconnected':'Die Verbindung zu Chrome wurde getrennt. Verbinden Sie sich erneut.',
  'queue-full':'Zu viele Browser-Aktionen warten in der Reihe. Warten Sie kurz und versuchen Sie es erneut.',
  'observe-failed':'Die Seite hat beim Lesen nicht rechtzeitig geantwortet. Laden Sie sie neu oder versuchen Sie es erneut.',
  'approval-pending':'Eine andere Browser-Verbindung wird noch beendet. Versuchen Sie es gleich erneut.',
  'profile-mismatch':'Das gewählte Profil passt nicht zum offenen Browser. Schließen Sie den aktuellen Browser und verbinden Sie sich erneut.',
  'tab-limit':'Eine Aufgabe kann bis zu 6 Tabs enthalten. Schließen Sie zuerst einen nicht genutzten Tab.',
  'tab-not-in-set':'Dieser Tab gehört nicht mehr zu dieser Aufgabe. Wählen Sie oben einen offenen Tab aus.',
  'stale-observation':'Die Seite hat sich seit dem letzten Lesen geändert. Prüfen Sie die Seite erneut, bevor Sie fortfahren.',
  'take-control-first':'Die Steuerung liegt derzeit beim Assistenten. Wählen Sie zuerst Selbst übernehmen.',
  'popup-open':'Ein Anmeldefenster ist noch geöffnet. Beenden Sie die Anmeldung und schließen Sie das Fenster zuerst.',
  'invalid-address':'Diese Adresse hat kein gültiges Format. Prüfen Sie die Adresse und versuchen Sie es erneut.',
  'profile-timeout':'Der Browser hat zum Starten zu lange gebraucht. Warten Sie kurz und öffnen Sie die Seite erneut.',
  'still-closing':'Der vorherige Browser wird noch geschlossen. Warten Sie einen Moment und versuchen Sie es erneut.',
  'profile-in-use':'Dieses Browser-Profil ist bereits in einer anderen Aufgabe geöffnet. Schließen Sie es zuerst dort.',
  'workroom-limit':'Es sind bereits vier Browser-Aufgaben gleichzeitig geöffnet. Schließen Sie zuerst einen Browser in einer anderen Aufgabe.',
  'other-window':'Dieser Browser gehört zu einem anderen Fenster. Arbeiten Sie bitte in jenem Fenster weiter.',
  'embedded-unavailable':'Der integrierte Browser ist auf diesem Gerät nicht verfügbar. Verbinden Sie Mein Chrome, um fortzufahren.',
  'workspace-changed':'Der Verbindungsstatus des Browsers hat sich geändert. Prüfen Sie die Seite oder verbinden Sie sich erneut.',
  'grant-unavailable':'Der Browserzugriff konnte nicht vorbereitet werden. Übernehmen Sie kurz selbst und übergeben Sie die Seite erneut.',
  'reload-would-resubmit':'Ein Neuladen würde ein Formular erneut absenden und wurde gestoppt. Öffnen Sie die Adresse über die Adressleiste neu.',
  'target-lost':'Die Verbindung zur offenen Seite wurde unterbrochen. Lassen Sie die Seite offen und wählen Sie Verbindung erneut versuchen.',
  'load-refused':'{host} hat die Verbindung abgelehnt. Prüfen Sie, ob der Entwicklungsserver läuft.',
  'load-timeout':'{host} hat zu lange nicht geantwortet. Prüfen Sie, ob der Entwicklungsserver läuft.',
  'load-name-not-resolved':'Die Adresse für {host} wurde nicht gefunden. Prüfen Sie die Schreibweise und Ihre Netzwerkverbindung.',
  'load-offline':'Keine Verbindung zum Netzwerk. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
  'load-certificate':'Das Sicherheitszertifikat für {host} konnte nicht bestätigt werden. Prüfen Sie die Adresse oder öffnen Sie eine sichere Seite.',
  generic:'Die Browser-Aktion konnte nicht ausgeführt werden. Versuchen Sie es gleich erneut.',
 },
};

function buildPageErrorCopy(
 lang:Lang,
 base:{
  title:string;
  offlineTitle:string;
  tryHeading:string;
  tryServer:string;
  tryAddress:string;
  tryNetwork:string;
  retry:string;
  editAddress:string;
 },
):BrowserPageErrorCopy{
 const tryList=[base.tryServer,base.tryAddress,base.tryNetwork] as const;
 const errors=workroomBrowserErrorMessages[lang];
 const makeCard=(code:BrowserLoadErrorCode,title:string):BrowserPageErrorCardCopy=>({
  title,
  cause:errors[code],
  tryHeading:base.tryHeading,
  tryList,
  retry:base.retry,
  editAddress:base.editAddress,
 });
 return {
  ...base,
  tryList,
  cards:{
   'load-refused':makeCard('load-refused',base.title),
   'load-timeout':makeCard('load-timeout',base.title),
   'load-name-not-resolved':makeCard('load-name-not-resolved',base.title),
   'load-offline':makeCard('load-offline',base.offlineTitle),
   'load-certificate':makeCard('load-certificate',base.title),
  },
 };
}

export const workroomBrowserPageErrorMessages:Record<Lang,BrowserPageErrorCopy>={
 ko:buildPageErrorCopy('ko',{
  title:'{host}에 연결할 수 없습니다',
  offlineTitle:'네트워크에 연결되어 있지 않습니다',
  tryHeading:'확인해 볼 것',
  tryServer:'개발 서버가 실행 중인지 확인하세요',
  tryAddress:'주소와 포트 번호가 맞는지 확인하세요',
  tryNetwork:'네트워크 연결 상태를 확인하세요',
  retry:'다시 시도',
  editAddress:'주소 수정',
 }),
 en:buildPageErrorCopy('en',{
  title:'Can’t reach {host}',
  offlineTitle:'You’re not connected to the network',
  tryHeading:'Things to check',
  tryServer:'Check whether the local dev server is running',
  tryAddress:'Check the address and port number',
  tryNetwork:'Check your network connection',
  retry:'Try again',
  editAddress:'Edit address',
 }),
 ja:buildPageErrorCopy('ja',{
  title:'{host} に接続できません',
  offlineTitle:'ネットワークに接続されていません',
  tryHeading:'確認すること',
  tryServer:'開発サーバーが起動しているか確認してください',
  tryAddress:'アドレスとポート番号が正しいか確認してください',
  tryNetwork:'ネットワークの接続状態を確認してください',
  retry:'再試行',
  editAddress:'アドレスを修正',
 }),
 'zh-CN':buildPageErrorCopy('zh-CN',{
  title:'无法连接到 {host}',
  offlineTitle:'当前未连接到网络',
  tryHeading:'可检查的项目',
  tryServer:'请检查本地开发服务器是否正在运行',
  tryAddress:'请检查地址和端口号是否正确',
  tryNetwork:'请检查网络连接状态',
  retry:'重试',
  editAddress:'修改地址',
 }),
 es:buildPageErrorCopy('es',{
  title:'No se puede conectar con {host}',
  offlineTitle:'No hay conexión a la red',
  tryHeading:'Qué puedes comprobar',
  tryServer:'Comprueba si el servidor de desarrollo está en marcha',
  tryAddress:'Comprueba que la dirección y el puerto sean correctos',
  tryNetwork:'Comprueba tu conexión de red',
  retry:'Reintentar',
  editAddress:'Editar dirección',
 }),
 fr:buildPageErrorCopy('fr',{
  title:'Impossible de joindre {host}',
  offlineTitle:'Aucune connexion au réseau',
  tryHeading:'Points à vérifier',
  tryServer:'Vérifiez si le serveur de développement est lancé',
  tryAddress:'Vérifiez que l’adresse et le port sont corrects',
  tryNetwork:'Vérifiez votre connexion réseau',
  retry:'Réessayer',
  editAddress:'Modifier l’adresse',
 }),
 de:buildPageErrorCopy('de',{
  title:'{host} ist nicht erreichbar',
  offlineTitle:'Keine Verbindung zum Netzwerk',
  tryHeading:'Bitte prüfen',
  tryServer:'Prüfen Sie, ob der Entwicklungsserver läuft',
  tryAddress:'Prüfen Sie, ob Adresse und Portnummer stimmen',
  tryNetwork:'Prüfen Sie Ihre Netzwerkverbindung',
  retry:'Erneut versuchen',
  editAddress:'Adresse bearbeiten',
 }),
};

export function workroomBrowserErrorCopy(lang:Lang):Record<BrowserErrorCode,string>{
 return workroomBrowserErrorMessages[lang]??workroomBrowserErrorMessages.en;
}

export function workroomBrowserPageErrorCopy(lang:Lang):BrowserPageErrorCopy{
 return workroomBrowserPageErrorMessages[lang]??workroomBrowserPageErrorMessages.en;
}
