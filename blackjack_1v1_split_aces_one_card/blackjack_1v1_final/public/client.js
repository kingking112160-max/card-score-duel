
const socket=io();
let state=null,ROLE=null,ready=false;
let previousScores={host:null,challenger:null};
const $=id=>document.getElementById(id);

function val(hand){
  let total=0,aces=0;
  for(const c of hand){
    if(c.r==="A"){total+=11;aces++}
    else if(["K","Q","J"].includes(c.r)) total+=10;
    else total+=Number(c.r);
  }
  while(total>21&&aces){total-=10;aces--}
  return total;
}
function cardHTML(c,hidden=false){
  if(hidden) return '<div class="card back">X</div>';
  const red=(c.s==="♥"||c.s==="♦")?" red":"";
  return `<div class="card${red}">
    <span>${c.r}${c.s}</span>
    <span class="suit-large">${c.s}</span>
  </div>`;
}
function handsHTML(p){
  if(!p.hands?.length) return '<div class="hand-label">카드 대기 중</div>';
  return p.hands.map((h,i)=>{
    const isActive=i===p.activeHand && !p.done && !h.done;
    return `
    <div class="hand-block${isActive?' active-hand':''}">
      <div class="hand-label">HAND ${i+1}${isActive?' · ACTIVE':''}${h.double?' · DOUBLE':''}</div>
      <div class="cards">${h.cards.map(c=>cardHTML(c)).join("")}</div>
      <div class="total">합계 ${val(h.cards)}</div>
    </div>
  `}).join("");
}
function applyMine(){
  const host=document.querySelector(".player.host");
  const challenger=document.querySelector(".player.challenger");
  if(!host||!challenger)return;
  host.classList.toggle("mine",ROLE==="host");
  challenger.classList.toggle("mine",ROLE==="challenger");
}

function showScoreChange(role,delta){
  if(!delta) return;

  const panel=document.querySelector(".player."+role);
  if(!panel) return;

  const fx=document.createElement("div");
  fx.className="score-change-fx "+(delta>0?"gain":"loss");
  fx.textContent=(delta>0?"+":"")+delta;

  panel.appendChild(fx);

  panel.classList.remove("score-pulse-gain","score-pulse-loss");
  void panel.offsetWidth;
  panel.classList.add(delta>0?"score-pulse-gain":"score-pulse-loss");

  setTimeout(()=>fx.remove(),1400);
  setTimeout(()=>panel.classList.remove("score-pulse-gain","score-pulse-loss"),900);
}

function detectScoreChanges(){
  if(!state) return;

  for(const role of ["host","challenger"]){
    const current=Number(state[role]?.score||0);
    const previous=previousScores[role];

    if(previous!==null && current!==previous){
      showScoreChange(role,current-previous);
    }

    previousScores[role]=current;
  }
}

function copyJoinLink(){
  const el=$("shareLink");
  if(!el) return;

  const raw=el.dataset.url || el.textContent.replace(/^도전자 링크:\s*/,"").trim();

  navigator.clipboard.writeText(raw).then(()=>{
    const btn=$("copyLinkBtn");
    if(btn){
      const old=btn.textContent;
      btn.textContent="복사 완료 ✓";
      setTimeout(()=>btn.textContent=old,1600);
    }
  }).catch(()=>{
    const textarea=document.createElement("textarea");
    textarea.value=raw;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();

    const btn=$("copyLinkBtn");
    if(btn){
      const old=btn.textContent;
      btn.textContent="복사 완료 ✓";
      setTimeout(()=>btn.textContent=old,1600);
    }
  });
}

function render(){
  if(!ready||!state)return;
  applyMine();
  $("roomCode").textContent=state.code;
  $("round").textContent=`ROUND ${state.round}`;
  $("status").textContent=state.message;
  $("shoe").textContent=`8 DECK · ${state.cardsRemaining} CARDS`;

  // Dealer zone is independent from player/split zones, so split hands never cover it.
  const hide=state.phase==="playing";
  $("dealerCards").innerHTML=(state.dealer||[]).map((c,i)=>cardHTML(c,hide&&i===1)).join("");
  $("dealerTotal").textContent=state.dealer?.length
    ? `DEALER ${hide?val([state.dealer[0]]):val(state.dealer)}`
    : "DEALER";

  for(const role of ["host","challenger"]){
    const p=state[role];
    $(role+"Name").textContent=p.name;
    $(role+"Score").textContent=(p.score>0?"+":"")+p.score;
    $(role+"Hands").innerHTML=handsHTML(p);

    const panel=document.querySelector(".player."+role);
    if(panel){
      panel.classList.toggle("split-view",p.hands && p.hands.length>=2);
      panel.classList.toggle("multi-split-view",p.hands && p.hands.length>=3);
      panel.classList.toggle("four-hand-view",p.hands && p.hands.length>=4);
    }
  }

  const mine=state[ROLE];
  const active=state.phase==="playing"&&!mine.done&&!state.finished;
  const insurancePhase=state.phase==="insurance";
  const insurancePending=insurancePhase && mine.insuranceDecision===null;

  ["hit","stand","double"].forEach(id=>$(id).disabled=!active);

  const splitBtn=$("split");
  if(splitBtn){
    const used=mine.splitCount||0;
    const splitLimitReached=used>=1;
    splitBtn.disabled=!active || splitLimitReached;
    splitBtn.textContent=splitLimitReached
      ? "SPLIT · MAX"
      : `↔ SPLIT (${used}/1)`;
  }

  const insuranceBtn=$("insurance");
  const noInsuranceBtn=$("noInsurance");
  if(insuranceBtn){
    insuranceBtn.classList.toggle("hidden",!insurancePhase);
    insuranceBtn.disabled=!insurancePending;
  }
  if(noInsuranceBtn){
    noInsuranceBtn.classList.toggle("hidden",!insurancePhase);
    noInsuranceBtn.disabled=!insurancePending;
  }

  if($("startBtn")){
    $("startBtn").disabled=!(
      state.host.connected&&state.challenger.connected&&
      (state.phase==="waiting"||state.phase==="idle")&&!state.finished
    );
  }
  if($("nextBtn")) $("nextBtn").disabled=state.phase!=="result"||state.finished;
}

function showWinnerModal(){
  if(!state?.finished || !state?.winner) return;
  const modal=$("winnerModal");
  if(!modal) return;

  const title=$("winnerTitle");
  const sub=$("winnerSub");

  title.textContent=`${state.winner} 승리!`;

  if(state.winner==="블랙잭 킹"){
    sub.textContent="최종 승자: 블랙잭 킹";
  }else{
    sub.textContent=`최종 승자: ${state.winner}`;
  }

  modal.classList.remove("hidden");
}

function hideWinnerModal(){
  const modal=$("winnerModal");
  if(modal) modal.classList.add("hidden");
}

socket.on("state",s=>{state=s;render();detectScoreChanges();if(state.finished)showWinnerModal();});

setInterval(()=>{
  if(!ready)return;
  const left=state?.timerDeadline?Math.max(0,Math.ceil((state.timerDeadline-Date.now())/1000)):20;
  $("timer").textContent=left;
  $("timer").style.color=left<=5?"#ff4e47":"var(--gold)";
},200);

["hit","stand","double","split"].forEach(a=>$(a).onclick=()=>socket.emit("action",a));
if($("insurance")) $("insurance").onclick=()=>socket.emit("insuranceDecision",true);
if($("noInsurance")) $("noInsurance").onclick=()=>socket.emit("insuranceDecision",false);
if($("startBtn")) $("startBtn").onclick=()=>socket.emit("startGame");
if($("nextBtn")) $("nextBtn").onclick=()=>socket.emit("nextRound");

function showNewMatchModal(){
  if(!$("newMatchModal")) return;
  $("newMatchModal").classList.remove("hidden");
}
function hideNewMatchModal(){
  if(!$("newMatchModal")) return;
  $("newMatchModal").classList.add("hidden");
}
if($("newBtn")) $("newBtn").onclick=showNewMatchModal;
if($("modalCancel")) $("modalCancel").onclick=hideNewMatchModal;
if($("modalConfirm")) $("modalConfirm").onclick=()=>{
  hideNewMatchModal();
  socket.emit("newMatch");
};
if($("newMatchModal")){
  $("newMatchModal").addEventListener("click",e=>{
    if(e.target===$("newMatchModal")) hideNewMatchModal();
  });
}
if($("closeBtn")) $("closeBtn").onclick=()=>socket.emit("closeRoom");
if($("exitBtn")) $("exitBtn").onclick=()=>{
  if(confirm("정말로 나가시겠습니까?")) location.href=ROLE==="host"?"/king":"/join";
};

socket.on("roomClosed",()=>{
  alert("방이 종료되었습니다.");
  location.href="/join";
});

socket.on("forcedLogout",data=>{
  alert(data?.reason || "새 매치가 시작되어 로그아웃되었습니다.");
  sessionStorage.removeItem("bj_room_code");
  sessionStorage.removeItem("bj_host_token");
  location.href="/join";
});


if($("winnerClose")) $("winnerClose").onclick=hideWinnerModal;


if($("copyLinkBtn")) $("copyLinkBtn").onclick=copyJoinLink;




socket.on("newRoomCreated",data=>{
  previousScores={host:null,challenger:null};

  sessionStorage.setItem("bj_room_code",data.code);
  sessionStorage.setItem("bj_host_token",data.hostToken);

  const roomCode=$("roomCode");
  if(roomCode) roomCode.textContent=data.code;

  const shareLink=$("shareLink");
  if(shareLink){
    const joinUrl=location.origin+data.joinPath;
    shareLink.textContent="도전자 링크: "+joinUrl;
    shareLink.dataset.url=joinUrl;
  }

  hideNewMatchModal();

  const btn=$("copyLinkBtn");
  if(btn){
    btn.textContent="도전자 링크 복사";
  }
});
