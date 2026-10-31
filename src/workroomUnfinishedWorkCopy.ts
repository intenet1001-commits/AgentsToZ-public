import type {Lang} from './i18n';

export const workroomUnfinishedWorkCopy:Record<Lang,{label:string;title:string;occupied:string;request:string}>={
 ko:{label:'미처리 업무 조회',title:'현재 세션의 입력칸에 조회 요청을 준비합니다. 전송은 직접 누르세요.',occupied:'작성 중인 요청과 첨부를 유지했습니다. 먼저 전송하거나 비운 뒤 미처리 업무 조회를 여세요.',request:'agentstoz-unfinished-work 스킬을 사용해 이 프로젝트의 미처리 업무를 확인해 주세요.'},
 en:{label:'Review unfinished work',title:'Prepare a review request in this session. Send it when ready.',occupied:'Your draft and attachments were kept. Send or clear them before preparing this request.',request:'Use the agentstoz-unfinished-work skill to review this project’s unfinished work.'},
 ja:{label:'未完了の業務を確認',title:'このセッションの入力欄に確認依頼を準備します。送信はご自身で行ってください。',occupied:'作成中の依頼と添付は保持しました。送信または消去してから確認依頼を準備してください。',request:'agentstoz-unfinished-work スキルを使って、このプロジェクトの未完了の業務を確認してください。'},
 'zh-CN':{label:'查看未完成的工作',title:'在当前会话的输入框中准备查询请求，请自行发送。',occupied:'已保留正在编辑的请求和附件。请先发送或清空，再准备查询请求。',request:'请使用 agentstoz-unfinished-work 技能查看此项目的未完成工作。'},
 es:{label:'Revisar trabajo pendiente',title:'Prepara una solicitud en esta sesión. Envíala cuando quieras.',occupied:'Se conservaron el borrador y los archivos adjuntos. Envíalos o bórralos antes de preparar esta solicitud.',request:'Usa la habilidad agentstoz-unfinished-work para revisar el trabajo pendiente de este proyecto.'},
 fr:{label:'Consulter le travail en attente',title:'Prépare une demande dans cette session. Envoyez-la quand vous le souhaitez.',occupied:'Votre brouillon et vos pièces jointes ont été conservés. Envoyez-les ou effacez-les avant de préparer cette demande.',request:'Utilisez la compétence agentstoz-unfinished-work pour examiner le travail en attente de ce projet.'},
 de:{label:'Offene Aufgaben prüfen',title:'Bereitet eine Anfrage in dieser Sitzung vor. Senden Sie sie selbst ab.',occupied:'Ihr Entwurf und Ihre Anhänge wurden beibehalten. Senden oder leeren Sie diese, bevor Sie die Anfrage vorbereiten.',request:'Verwende den Skill agentstoz-unfinished-work, um die offenen Aufgaben dieses Projekts zu prüfen.'},
};
