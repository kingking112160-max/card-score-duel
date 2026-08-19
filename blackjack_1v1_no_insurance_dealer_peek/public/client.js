
const socket=io();
let state=null,ROLE=null,ready=false;
let previousScores={host:null,challenger:null};
const $=id=>document.getElementById(id);

function val(hand){
  let total=0,aces=0;
  for(const c of hand){
    if(c.r==="A"){total+=11;aces++}
    else if(["K","Q","J"].includes(c.r))total+=10;
    else total+=Number(c.r);
  }
  while(total>21&&aces){total-=10;aces--}
  return total;
}
function cardHTML(c,hidden=false){
  if(hidden)return '<div class="card back">X</div>';
  const red=(c.s==="♥"||c.s==="♦")?" red":"";
  return `<div class="card${red}"><span>${c.r}${c.s}</span><span class="suit-large">${c.s}</span></div>`;
}
function handsHTML(p){
  if(!p.hands?.length)return '<div class="hand-label">카드 대기 중</div>';
  return p.hands.map((h,i)=>{
    const isActive=i===p.activeHand&&!p.done&&!h.done;
    return `<div class="hand-block${isActive?' active-hand':''}">
      <div class="hand-label">HAND ${i+1}${isActive?' · ACTIVE':''}${h.double?' · DOUBLE':''}${h.splitAces?' · A SPLIT LOCK':''}</div>
      <div class="cards">${h.cards.map(c=>cardHTML(c)).join("")}</div>
      <div class="total">합계 ${val(h.cards)}</div>
    </div>`;
  }).join("");
}
function applyMine(){
  const host=document.querySelector(".player.host");
  const chal=document.querySelector(".player.challenger");
  if(!host||!chal)return;
  host.classList.toggle("mine",ROLE==="host");
  chal.classList.toggle("mine",ROLE==="challenger");
}
function showScoreChange(role,delta){
  if(!delta)return;
  const panel=document.querySelector(".player."+role);
  if(!panel)return;
  const fx=document.createElement("div");
  fx.className="score-change-fx "+(delta>0?"gain":"loss");
  fx.textContent=(delta>0?"+":"")+delta;
  panel.appendChild(fx);
  setTimeout(()=>fx.remove(),1400);
}
function detectScoreChanges(){
  if(!state)return;
  for(const role of ["host","challenger"]){
    const current=Number(state[role]?.score||0);
    const prev=previousScores[role];
    if(prev!==null && current!==prev)showScoreChange(role,current-prev);
    previousScores[role]=current;
  }
}
function render(){
  if(!ready||!state)return;
  applyMine();

  $("roomCode").textContent=state.code;
  $("round").textContent=`ROUND ${state.round}`;
  $("status").textContent=state.message;
  $("shoe").textContent=`8 DECK · ${state.cardsRemaining} CARDS`;

  // 플레이 중에는 딜러 업카드만 공개하고 홀카드는 가린다.
  // 딜러 블랙잭이 확정되거나 라운드 결과가 난 뒤에만 전체 패 공개.
  const hideHole = state.phase==="playing";
  $("dealerCards").innerHTML=(state.dealer||[]).map((c,i)=>cardHTML(c,hideHole&&i===1)).join("");
  $("dealerTotal").textContent=state.dealer?.length
    ? `DEALER ${hideHole?val([state.dealer[0]]):val(state.dealer)}`
    : "DEALER";

  for(const role of ["host","challenger"]){
    const p=state[role];
    $(role+"Name").textContent=p.name;
    $(role+"Score").textContent=(p.score>0?"+":"")+p.score;
    $(role+"Hands").innerHTML=handsHTML(p);

    const panel=document.querySelector(".player."+role);
    if(panel) panel.classList.toggle("split-view",p.hands&&p.hands.length>=2);
  }

  const mine=state[ROLE];
  const active=state.phase==="playing"&&!mine.done&&!state.finished;

  ["hit","stand","double"].forEach(id=>$(id).disabled=!active);

  const splitBtn=$("split");
  if(splitBtn){
    const used=mine.splitCount||0;
    const limit=used>=1;
    splitBtn.disabled=!active||limit;
    splitBtn.textContent=limit?"SPLIT · MAX":`↔ SPLIT (${used}/1)`;
  }

  if($("startBtn")){
    $("startBtn").disabled=!(state.host.connected&&state.challenger.connected&&(state.phase==="waiting"||state.phase==="idle")&&!state.finished);
  }
  if($("nextBtn"))$("nextBtn").disabled=state.phase!=="result"||state.finished;
}
function showWinnerModal(){
  if(!state?.finished||!state?.winner)return;
  $("winnerTitle").textContent=`${state.winner} 승리!`;
  $("winnerSub").textContent=`최종 승자: ${state.winner}`;
  $("winnerModal").classList.remove("hidden");
}
function hideWinnerModal(){
  $("winnerModal")?.classList.add("hidden");
}
function showNewMatchModal(){
  if(!$("newMatchModal"))return;
  $("newPassword").value="";
  $("newMatchError").textContent="";
  $("newMatchModal").classList.remove("hidden");
  setTimeout(()=>$("newPassword")?.focus(),30);
}
function hideNewMatchModal(){
  $("newMatchModal")?.classList.add("hidden");
}
async function copyJoinLink(){
  const el=$("shareLink");
  if(!el)return;
  const raw=el.dataset.url||el.textContent.replace(/^도전자 링크:\s*/,"").trim();
  try{
    await navigator.clipboard.writeText(raw);
  }catch{
    const ta=document.createElement("textarea");
    ta.value=raw;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();
  }
  const btn=$("copyLinkBtn");
  if(btn){const old=btn.textContent;btn.textContent="복사 완료 ✓";setTimeout(()=>btn.textContent=old,1500);}
}

socket.on("state",s=>{
  state=s;
  render();
  detectScoreChanges();
  if(state.finished)showWinnerModal();
});

setInterval(()=>{
  if(!ready)return;
  const left=state?.timerDeadline?Math.max(0,Math.ceil((state.timerDeadline-Date.now())/1000)):20;
  $("timer").textContent=left;
  $("timer").style.color=left<=5?"#ff4e47":"var(--gold)";
},200);

["hit","stand","double","split"].forEach(a=>$(a).onclick=()=>socket.emit("action",a));
if($("startBtn"))$("startBtn").onclick=()=>socket.emit("startGame");
if($("nextBtn"))$("nextBtn").onclick=()=>socket.emit("nextRound");
if($("newBtn"))$("newBtn").onclick=showNewMatchModal;
if($("modalCancel"))$("modalCancel").onclick=hideNewMatchModal;
if($("modalConfirm"))$("modalConfirm").onclick=()=>{
  const password=$("newPassword").value.trim();
  if(password.length<4){
    $("newMatchError").textContent="새 비밀번호를 4자 이상 입력하세요.";
    return;
  }
  socket.emit("newMatch",{password});
};
if($("winnerClose"))$("winnerClose").onclick=hideWinnerModal;
if($("copyLinkBtn"))$("copyLinkBtn").onclick=copyJoinLink;
if($("exitBtn"))$("exitBtn").onclick=()=>{
  if(confirm("정말로 나가시겠습니까?"))location.href=ROLE==="host"?"/king":"/join";
};

socket.on("newMatchResult",data=>{
  if(!data.ok){
    $("newMatchError").textContent=data.message||"새 매치를 만들 수 없습니다.";
    return;
  }

  previousScores={host:null,challenger:null};
  sessionStorage.setItem("bj_room_code",data.code);
  sessionStorage.setItem("bj_host_token",data.hostToken);

  const joinUrl=location.origin+data.joinPath;
  $("roomCode").textContent=data.code;
  $("shareLink").textContent="도전자 링크: "+joinUrl;
  $("shareLink").dataset.url=joinUrl;
  hideNewMatchModal();
});

socket.on("forcedLogout",data=>{
  alert(data?.reason||"새 매치가 시작되어 로그아웃되었습니다.");
  location.href="/join";
});
socket.on("roomClosed",()=>{
  alert("방이 종료되었습니다.");
  location.href="/join";
});
