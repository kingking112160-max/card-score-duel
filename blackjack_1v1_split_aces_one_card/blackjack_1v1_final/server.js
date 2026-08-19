
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req,res)=>res.redirect("/join"));
app.get("/king", (req,res)=>res.sendFile(path.join(__dirname,"public","king.html")));
app.get("/join", (req,res)=>res.sendFile(path.join(__dirname,"public","join.html")));

const rooms = new Map();

function makeCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code="";
  do{
    code="";
    for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  }while(rooms.has(code));
  return code;
}
function hash(s){
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function freshShoe(){
  const suits=["♠","♥","♦","♣"];
  const ranks=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const shoe=[];
  for(let d=0; d<8; d++){
    for(const s of suits){
      for(const r of ranks) shoe.push({s,r});
    }
  }
  for(let i=shoe.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [shoe[i],shoe[j]]=[shoe[j],shoe[i]];
  }
  return shoe;
}
function newPlayer(name){
  return {
    name,
    score:0,
    hands:[],
    activeHand:0,
    done:false,
    insuranceChosen:false,
    insuranceDecision:null,
    splitCount:0,
    connected:false,
    socketId:null
  };
}
function newGame(){
  return {
    round:1,
    phase:"waiting",
    shoe:freshShoe(),
    dealer:[],
    host:newPlayer("블랙잭 킹"),
    challenger:newPlayer("도전자"),
    timerDeadline:null,
    message:"도전자를 기다리는 중입니다.",
    finished:false,
    winner:null
  };
}
function makeRoom(code,password,hostToken){
  return {
    code,
    passwordHash:hash(password),
    hostToken,
    createdAt:Date.now(),
    game:newGame()
  };
}
function getRoom(code){
  return rooms.get(String(code||"").trim().toUpperCase());
}
function draw(room){
  if(!room.game.shoe.length) room.game.shoe=freshShoe();
  return room.game.shoe.pop();
}
function handValue(hand){
  let total=0,aces=0;
  for(const c of hand){
    if(c.r==="A"){ total+=11; aces++; }
    else if(["K","Q","J"].includes(c.r)) total+=10;
    else total+=Number(c.r);
  }
  while(total>21 && aces){ total-=10; aces--; }
  return {total,soft:aces>0};
}
function blackjack(hand){
  return hand.length===2 && handValue(hand).total===21;
}
function normalize(p){
  while(p.activeHand<p.hands.length && p.hands[p.activeHand].done) p.activeHand++;
  p.done = p.activeHand>=p.hands.length;
}
function canSplit(hand){
  if(!hand || hand.cards.length!==2) return false;
  const a=hand.cards[0].r, b=hand.cards[1].r;
  const ten=r=>["10","J","Q","K"].includes(r);
  return a===b || (ten(a)&&ten(b));
}
function setTimer(room){
  room.game.timerDeadline=Date.now()+20000;
}
function publicState(room){
  const g=room.game;
  return {
    code:room.code,
    round:g.round,
    phase:g.phase,
    dealer:g.dealer,
    host:g.host,
    challenger:g.challenger,
    timerDeadline:g.timerDeadline,
    message:g.message,
    cardsRemaining:g.shoe.length,
    finished:g.finished,
    winner:g.winner
  };
}
function broadcast(room){
  io.to("room:"+room.code).emit("state", publicState(room));
}

function startRound(room){
  const g=room.game;
  if(g.finished || !g.host.connected || !g.challenger.connected) return;

  for(const p of [g.host,g.challenger]){
    p.hands=[{cards:[draw(room),draw(room)],done:false,double:false}];
    p.activeHand=0;
    p.done=false;
    p.splitCount=0;
    p.insuranceChosen=false;
    p.insuranceDecision=null;
    if(blackjack(p.hands[0].cards)) p.hands[0].done=true;
  }

  g.dealer=[draw(room),draw(room)];

  // 딜러 업카드가 A면 먼저 인슈어런스 선택 단계
  if(g.dealer[0].r==="A"){
    g.phase="insurance";
    g.message="딜러 업카드가 A입니다. 각자 INSURANCE 여부를 선택하세요.";
    setTimer(room);
    broadcast(room);
    return;
  }

  // 아메리칸 블랙잭: 딜러 10-value 업카드면 즉시 블랙잭 체크
  if(["10","J","Q","K"].includes(g.dealer[0].r) && blackjack(g.dealer)){
    resolveDealerBlackjack(room);
    return;
  }

  g.phase="playing";
  g.message="같은 딜러를 상대합니다. 각자 자신의 판단으로 플레이하세요.";
  normalize(g.host);
  normalize(g.challenger);
  setTimer(room);
  broadcast(room);
  finishIfReady(room);
}


function insuranceDecision(room,role,takeInsurance){
  const g=room.game;
  if(g.phase!=="insurance" || g.finished) return;

  const p=role==="host" ? g.host : g.challenger;
  if(p.insuranceDecision!==null) return;

  p.insuranceDecision=!!takeInsurance;

  if(takeInsurance){
    p.insuranceChosen=true;
    p.score-=1; // 선택 즉시 1점 차감
  }

  g.message=`인슈어런스 선택 중 · 블랙잭 킹 ${g.host.insuranceDecision===null?"대기":"완료"} / ${g.challenger.name} ${g.challenger.insuranceDecision===null?"대기":"완료"}`;
  broadcast(room);

  if(g.host.insuranceDecision!==null && g.challenger.insuranceDecision!==null){
    resolveInsurancePhase(room);
  }
}

function resolveInsurancePhase(room){
  const g=room.game;
  const dealerBJ=blackjack(g.dealer);

  if(dealerBJ){
    // 보험 선택자는 1점을 돌려받음
    for(const p of [g.host,g.challenger]){
      if(p.insuranceChosen) p.score+=1;
    }
    resolveDealerBlackjack(room);
    return;
  }

  // 딜러 블랙잭이 아니면 보험 -1은 그대로 유지
  checkFinished(room);
  if(g.finished){
    broadcast(room);
    return;
  }

  g.phase="playing";
  g.message="딜러는 블랙잭이 아닙니다. 플레이를 진행하세요.";
  normalize(g.host);
  normalize(g.challenger);
  setTimer(room);
  broadcast(room);
  finishIfReady(room);
}

function resolveDealerBlackjack(room){
  const g=room.game;

  // 딜러 블랙잭이면 라운드를 즉시 종료.
  // 플레이어도 내추럴 블랙잭이면 PUSH(0), 아니면 -1.
  let hostDelta=blackjack(g.host.hands[0]?.cards||[]) ? 0 : -1;
  let challengerDelta=blackjack(g.challenger.hands[0]?.cards||[]) ? 0 : -1;

  g.host.score+=hostDelta;
  g.challenger.score+=challengerDelta;

  g.host.done=true;
  g.challenger.done=true;
  g.phase="result";
  g.timerDeadline=null;

  g.message=`딜러 BLACKJACK · 라운드 즉시 종료 · 블랙잭 킹 ${hostDelta>=0?"+":""}${hostDelta}점 / ${g.challenger.name} ${challengerDelta>=0?"+":""}${challengerDelta}점`;

  checkFinished(room);
  broadcast(room);
}

function action(room,role,type){
  const g=room.game;
  if(g.phase!=="playing" || g.finished) return;

  const p=role==="host" ? g.host : g.challenger;
  normalize(p);
  if(p.done) return;

  const h=p.hands[p.activeHand];
  if(!h || h.done) return;

  // 스플릿 A는 각 핸드에 카드 1장만 받고 추가 액션 불가
  if(h.splitAces) return;

  if(type==="hit"){
    h.cards.push(draw(room));
    if(handValue(h.cards).total>=21) h.done=true;
  }
  else if(type==="stand"){
    h.done=true;
  }
  else if(type==="double"){
    if(h.cards.length!==2) return;
    h.double=true;
    h.cards.push(draw(room));
    h.done=true;
  }
  else if(type==="split"){
    if(p.splitCount>=1) return;
    if(!canSplit(h)) return;

    const [c1,c2]=h.cards;
    const splitAces = c1.r==="A" && c2.r==="A";

    p.hands.splice(
      p.activeHand,
      1,
      {cards:[c1,draw(room)],done:splitAces,double:false,splitAces},
      {cards:[c2,draw(room)],done:splitAces,double:false,splitAces}
    );

    p.splitCount++;
  }

  normalize(p);
  setTimer(room);
  broadcast(room);
  finishIfReady(room);
}

function dealerPlay(room){
  const g=room.game;
  while(true){
    const v=handValue(g.dealer);
    if(v.total<17) g.dealer.push(draw(room));
    else break; // S17
  }
}

function scoreHand(room,h){
  const g=room.game;
  const p=handValue(h.cards).total;
  const d=handValue(g.dealer).total;
  const pbj=blackjack(h.cards);
  const dbj=blackjack(g.dealer);

  let result=0;
  if(p>21) result=-1;
  else if(dbj && !pbj) result=-1;
  else if(pbj && !dbj) return 2; // 내추럴 블랙잭 승리 +2
  else if(d>21) result=1;
  else if(p>d) result=1;
  else if(p<d) result=-1;
  else result=0;

  return h.double ? result*2 : result;
}
function settlePlayer(room,p){
  let delta=0;
  for(const h of p.hands) delta += scoreHand(room,h);
  p.score += delta;
  return delta;
}
function checkFinished(room){
  const g=room.game;

  if(g.host.score>=15){
    g.finished=true; g.winner="블랙잭 킹";
    g.message="블랙잭 킹이 +15점에 먼저 도달했습니다. 블랙잭 킹 승리!";
  }
  else if(g.challenger.score>=15){
    g.finished=true; g.winner=g.challenger.name;
    g.message=`${g.challenger.name}이(가) +15점에 먼저 도달했습니다. 도전자 승리!`;
  }
  else if(g.host.score<=-15){
    g.finished=true; g.winner=g.challenger.name;
    g.message=`블랙잭 킹이 -15점에 도달했습니다. ${g.challenger.name} 승리!`;
  }
  else if(g.challenger.score<=-15){
    g.finished=true; g.winner="블랙잭 킹";
    g.message=`${g.challenger.name}이(가) -15점에 도달했습니다. 블랙잭 킹 승리!`;
  }

  if(g.finished){
    g.phase="finished";
    g.timerDeadline=null;
  }
}
function finishIfReady(room){
  const g=room.game;
  normalize(g.host);
  normalize(g.challenger);

  if(!(g.host.done && g.challenger.done)) return;

  dealerPlay(room);

  const hd=settlePlayer(room,g.host);
  const cd=settlePlayer(room,g.challenger);

  g.phase="result";
  g.timerDeadline=null;
  g.message=`ROUND ${g.round} 종료 · 블랙잭 킹 ${hd>=0?"+":""}${hd}점 / ${g.challenger.name} ${cd>=0?"+":""}${cd}점`;

  checkFinished(room);
  broadcast(room);
}
function nextRound(room){
  const g=room.game;
  if(g.phase!=="result" || g.finished) return;
  g.round++;
  startRound(room);
}

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    const g=room.game;
    if(g.phase!=="playing" || !g.timerDeadline) continue;

    if(now>=g.timerDeadline){
      if(g.phase==="insurance"){
        if(g.host.insuranceDecision===null) g.host.insuranceDecision=false;
        if(g.challenger.insuranceDecision===null) g.challenger.insuranceDecision=false;
        g.message="인슈어런스 선택 시간 초과 · 미선택은 보험 안함 처리";
        broadcast(room);
        resolveInsurancePhase(room);
        continue;
      }

      for(const p of [g.host,g.challenger]){
        normalize(p);
        if(!p.done){
          const h=p.hands[p.activeHand];
          if(h) h.done=true;
          normalize(p);
        }
      }
      g.message="20초 시간 초과 · 미완료 활성 핸드는 자동 STAND 처리되었습니다.";
      setTimer(room);
      broadcast(room);
      finishIfReady(room);
    }
  }
},250);

io.on("connection",socket=>{

  socket.on("createRoom",({password})=>{
    password=String(password||"").trim();
    if(password.length<4){
      return socket.emit("createRoomResult",{ok:false,message:"비밀번호는 4자 이상으로 설정하세요."});
    }

    const code=makeCode();
    const hostToken=crypto.randomBytes(24).toString("hex");
    const room=makeRoom(code,password,hostToken);
    rooms.set(code,room);

    socket.data.roomCode=code;
    socket.data.role="host";
    socket.data.hostToken=hostToken;

    room.game.host.connected=true;
    room.game.host.socketId=socket.id;

    socket.join("room:"+code);
    socket.emit("createRoomResult",{
      ok:true,
      code,
      hostToken,
      joinPath:`/join?room=${code}`
    });
    broadcast(room);
  });

  socket.on("resumeHost",({code,hostToken})=>{
    const room=getRoom(code);
    if(!room || room.hostToken!==hostToken){
      return socket.emit("hostResumeResult",{ok:false});
    }

    socket.data.roomCode=room.code;
    socket.data.role="host";
    socket.data.hostToken=hostToken;

    room.game.host.connected=true;
    room.game.host.socketId=socket.id;

    socket.join("room:"+room.code);
    socket.emit("hostResumeResult",{ok:true});
    broadcast(room);
  });

  socket.on("joinRoom",({code,password,nickname})=>{
    const room=getRoom(code);

    if(!room){
      return socket.emit("joinRoomResult",{ok:false,message:"존재하지 않는 방입니다."});
    }
    if(room.passwordHash!==hash(password)){
      return socket.emit("joinRoomResult",{ok:false,message:"방 비밀번호가 틀렸습니다."});
    }
    if(room.game.challenger.connected){
      return socket.emit("joinRoomResult",{ok:false,message:"이미 도전자가 입장해 있습니다."});
    }

    const clean=String(nickname||"").trim().slice(0,18);
    if(!clean){
      return socket.emit("joinRoomResult",{ok:false,message:"닉네임을 입력하세요."});
    }

    socket.data.roomCode=room.code;
    socket.data.role="challenger";

    room.game.challenger.connected=true;
    room.game.challenger.socketId=socket.id;
    room.game.challenger.name=clean;
    room.game.message="도전자 입장 완료 · 블랙잭 킹의 게임 시작을 기다리는 중입니다.";

    socket.join("room:"+room.code);
    socket.emit("joinRoomResult",{ok:true,code:room.code});
    broadcast(room);
  });

  socket.on("insuranceDecision",takeInsurance=>{
    const room=getRoom(socket.data.roomCode);
    if(!room || !["host","challenger"].includes(socket.data.role)) return;
    insuranceDecision(room,socket.data.role,!!takeInsurance);
  });

  socket.on("action",type=>{
    const room=getRoom(socket.data.roomCode);
    if(!room || !["host","challenger"].includes(socket.data.role)) return;
    if(!["hit","stand","double","split"].includes(type)) return;
    action(room,socket.data.role,type);
  });

  socket.on("startGame",()=>{
    const room=getRoom(socket.data.roomCode);
    if(!room || socket.data.role!=="host") return;
    if(room.game.phase==="waiting" || room.game.phase==="idle"){
      startRound(room);
    }
  });

  socket.on("nextRound",()=>{
    const room=getRoom(socket.data.roomCode);
    if(!room || socket.data.role!=="host") return;
    nextRound(room);
  });

  socket.on("newMatch",()=>{
    const oldRoom=getRoom(socket.data.roomCode);
    if(!oldRoom || socket.data.role!=="host") return;

    const challengerSocketId=oldRoom.game.challenger.socketId;
    const oldCode=oldRoom.code;
    const password=oldRoom.password;

    // 현재 도전자 퇴장
    if(challengerSocketId){
      io.to(challengerSocketId).emit("forcedLogout",{
        reason:"블랙잭 킹이 새 매치를 시작했습니다. 새 도전자 링크로 다시 입장해주세요."
      });
      const challengerSocket=io.sockets.sockets.get(challengerSocketId);
      if(challengerSocket){
        challengerSocket.leave("room:"+oldCode);
        challengerSocket.data.roomCode=null;
        challengerSocket.data.role=null;
      }
    }

    // 기존 방 제거
    socket.leave("room:"+oldCode);
    rooms.delete(oldCode);

    // 반드시 새로운 6자리 방 코드 발급
    let newCode;
    do{
      newCode=makeCode();
    }while(rooms.has(newCode) || newCode===oldCode);

    const hostToken=crypto.randomBytes(24).toString("hex");
    const newRoom={
      code:newCode,
      password,
      hostToken,
      game:newGame()
    };

    newRoom.game.host.connected=true;
    newRoom.game.host.socketId=socket.id;
    newRoom.game.message="새 매치 준비 완료 · 새 도전자를 기다리는 중입니다.";

    rooms.set(newCode,newRoom);

    socket.join("room:"+newCode);
    socket.data.roomCode=newCode;
    socket.data.role="host";
    socket.data.hostToken=hostToken;

    // 킹 화면에 새 ROOM CODE와 새 참가 링크 전달
    socket.emit("newRoomCreated",{
      code:newCode,
      hostToken,
      joinPath:"/join?room="+newCode
    });

    broadcast(newRoom);
  });

  socket.on("closeRoom",()=>{
    const room=getRoom(socket.data.roomCode);
    if(!room || socket.data.role!=="host") return;

    io.to("room:"+room.code).emit("roomClosed");
    rooms.delete(room.code);
  });

  socket.on("disconnect",()=>{
    const room=getRoom(socket.data.roomCode);
    if(!room) return;

    if(socket.data.role==="host"){
      room.game.host.connected=false;
      room.game.host.socketId=null;
      room.game.message="블랙잭 킹 연결이 끊어졌습니다.";
    }

    if(socket.data.role==="challenger"){
      room.game.challenger.connected=false;
      room.game.challenger.socketId=null;
      room.game.message="도전자 연결이 끊어졌습니다.";
    }

    broadcast(room);
  });
});

server.listen(PORT,()=>console.log(`1v1 Blackjack server running on ${PORT}`));
