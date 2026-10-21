import '../../../src/index.css';
import './panel';

// Real shared tokens, with the phone's own theme on the remote surface.
document.body.style.fontFamily='var(--font-sans)';
document.body.style.margin='0';
if(new URLSearchParams(location.search).has('remote')){
 const link=document.createElement('link');link.rel='stylesheet';link.href='/remote-theme.css';document.head.append(link);
 document.getElementById('root')!.classList.add('remote-shell');
 const nav=document.createElement('nav');nav.className='workspace-navigation';nav.setAttribute('aria-label','작업 공간');
 for(const label of ['홈','프로젝트','원격 작업','북마크','기록']){const button=document.createElement('button');button.textContent=label;nav.append(button);}
 document.body.append(nav);
}
