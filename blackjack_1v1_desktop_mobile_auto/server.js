const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req,res)=>res.redirect('/join'));
app.get('/king', (req,res)=>res.sendFile(path.join(__dirname,'public','king.html')));
app.get('/join', (req,res)=>res.sendFile(path.join(__dirname,'public','join.html')));

const rooms = new Map();

function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do{
    code='';
    for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  }while(rooms.has(code));
  return code;
}
function hash(s){return crypto.createHash('sha256').update(String(s)).digest('hex')}
function freshShoe(){
  const suits=['♠','♥','♦','♣'];
  const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const shoe=[];
  for(let d=0;d<8;d++) for(const s of suits) for(const r of ranks) shoe.push({s,r});
  for(let i=shoe.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [shoe[i],shoe[j]]=[shoe[j],shoe[i]];
  }
  return shoe;
}
function newPlayer(name){
  return {name,score:0,hands:[],activeHand:0,done:false,splitCount:0,connected:false,socketId:null};
}
function newGame(){
  return {round:1,phase:'waiting',shoe:freshShoe(),dealer:[],host:newPlayer('블랙잭 킹'),challenger:newPlayer('도전자'),timerDeadline:null,nextRoundAt:null,message:'도전자를 기다리는 중입니다.',finished:false,winner:null};
}
function makeRoom(code,password,hostToken){
  return {code,passwordHash:hash(password),hostToken,createdAt:Date.now(),game:newGame()};
}
function getRoom(code){return rooms.get(String(code||'').trim().toUpperCase())}
function draw(room){if(!room.game.shoe.length) room.game.shoe=freshShoe(); return room.game.shoe.pop()}
function handValue(hand){
  let t=0,a=0;
  for(const c of hand){
    if(c.r==='A'){t+=11;a++}
    else if(['K','Q','J'].includes(c.r)) t+=10;
    else t+=Number(c.r);
  }
  while(t>21&&a){t-=10;a--}
  return {total:t,soft:a>0};
}
function blackjack(hand){return hand.length===2 && handValue(hand).total===21}
function normalize(p){while(p.activeHand<p.hands.length&&p.hands[p.activeHand].done)p.activeHand++;p.done=p.activeHand>=p.hands.length}
function canSplit(h){
  if(!h||h.cards.length!==2)return false;
  const a=h.cards[0].r,b=h.cards[1].r,ten=r=>['10','J','Q','K'].includes(r);
  return a===b||(ten(a)&&ten(b));
}
function setTimer(room){room.game.timerDeadline=Date.now()+20000}
function pub(room){
  const g=room.game;
  return {code:room.code,round:g.round,phase:g.phase,dealer:g.dealer,host:g.host,challenger:g.challenger,timerDeadline:g.timerDeadline,nextRoundAt:g.nextRoundAt,message:g.message,cardsRemaining:g.shoe.length,finished:g.finished,winner:g.winner};
}
function broadcast(room){io.to('room:'+room.code).emit('state',pub(room))}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function checkFinished(room){
  const g=room.game;
  if(g.host.score>=8){g.finished=true;g.winner='블랙잭 킹';g.message='블랙잭 킹이 +8점에 먼저 도달했습니다. 블랙잭 킹 승리!'}
  else if(g.challenger.score>=8){g.finished=true;g.winner=g.challenger.name;g.message=`${g.challenger.name}이(가) +8점에 먼저 도달했습니다. 도전자 승리!`}
  else if(g.host.score<=-8){g.finished=true;g.winner=g.challenger.name;g.message=`블랙잭 킹이 -8점에 도달했습니다. ${g.challenger.name} 승리!`}
  else if(g.challenger.score<=-8){g.finished=true;g.winner='블랙잭 킹';g.message=`${g.challenger.name}이(가) -8점에 도달했습니다. 블랙잭 킹 승리!`}
  if(g.finished){g.phase='finished';g.timerDeadline=null}
}

async function startRound(room){
  const g=room.game;
  if(g.finished||!g.host.connected||!g.challenger.connected)return;
  g.nextRoundAt=null;

  // 새 라운드는 카드가 한 장씩 보이도록 DEALING 단계에서 순차 배분한다.
  for(const p of [g.host,g.challenger]){
    p.hands=[{cards:[],done:false,double:false,splitAces:false}];
    p.activeHand=0;p.done=false;p.splitCount=0;
  }
  g.dealer=[];
  g.phase='dealing';
  g.timerDeadline=null;
  g.message='카드를 배분하고 있습니다...';
  broadcast(room);

  const sequence=[
    ()=>g.host.hands[0].cards.push(draw(room)),
    ()=>g.challenger.hands[0].cards.push(draw(room)),
    ()=>g.dealer.push(draw(room)),
    ()=>g.host.hands[0].cards.push(draw(room)),
    ()=>g.challenger.hands[0].cards.push(draw(room)),
    ()=>g.dealer.push(draw(room))
  ];

  for(const deal of sequence){
    if(rooms.get(room.code)!==room) return;
    deal();
    broadcast(room);
    await sleep(420);
  }

  if(blackjack(g.host.hands[0].cards)) g.host.hands[0].done=true;
  if(blackjack(g.challenger.hands[0].cards)) g.challenger.hands[0].done=true;

  // 아메리칸 블랙잭 피크: 업카드가 A 또는 10점 카드면 홀카드를 즉시 확인한다.
  // 블랙잭이 아니면 홀카드는 플레이 종료 때까지 계속 가린다.
  if((g.dealer[0].r==='A' || ['10','J','Q','K'].includes(g.dealer[0].r)) && blackjack(g.dealer)){
    resolveDealerBlackjack(room);return;
  }

  g.phase='playing';
  g.message='같은 딜러를 상대합니다. 각자 자신의 판단으로 플레이하세요.';
  normalize(g.host);normalize(g.challenger);setTimer(room);broadcast(room);finishIfReady(room);
}

function resolveDealerBlackjack(room){
  const g=room.game;
  const hd=blackjack(g.host.hands[0]?.cards||[])?0:-1;
  const cd=blackjack(g.challenger.hands[0]?.cards||[])?0:-1;
  g.host.score+=hd;g.challenger.score+=cd;g.host.done=true;g.challenger.done=true;
  g.phase='result';g.timerDeadline=null;
  g.message=`딜러 BLACKJACK · 라운드 즉시 종료 · 블랙잭 킹 ${hd>=0?'+':''}${hd}점 / ${g.challenger.name} ${cd>=0?'+':''}${cd}점`;
  checkFinished(room);
  if(g.finished) broadcast(room);
  else scheduleAutoNextRound(room);
}

function action(room,role,type){
  const g=room.game;if(g.phase!=='playing'||g.finished)return;
  const p=role==='host'?g.host:g.challenger;normalize(p);if(p.done)return;
  const h=p.hands[p.activeHand];if(!h||h.done||h.splitAces)return;

  if(type==='hit'){
    h.cards.push(draw(room));if(handValue(h.cards).total>=21)h.done=true;
  }else if(type==='stand'){
    h.done=true;
  }else if(type==='double'){
    if(h.cards.length!==2)return;h.double=true;h.cards.push(draw(room));h.done=true;
  }else if(type==='split'){
    if(p.splitCount>=1||!canSplit(h))return;
    const [c1,c2]=h.cards;const splitAces=c1.r==='A'&&c2.r==='A';
    p.hands.splice(p.activeHand,1,
      {cards:[c1,draw(room)],done:splitAces,double:false,splitAces},
      {cards:[c2,draw(room)],done:splitAces,double:false,splitAces}
    );
    p.splitCount++;
  }
  normalize(p);broadcast(room);finishIfReady(room);
}
async function dealerPlayAnimated(room){
  const g=room.game;
  // 먼저 홀카드를 공개한 뒤, 추가 카드는 한 장씩 천천히 뽑는다.
  g.phase='dealer';
  g.timerDeadline=null;
  g.message='딜러가 홀카드를 공개합니다.';
  broadcast(room);
  await sleep(500);

  while(handValue(g.dealer).total<17){
    if(rooms.get(room.code)!==room) return false;
    g.dealer.push(draw(room));
    g.message='딜러가 카드를 한 장 더 받습니다.';
    broadcast(room);
    await sleep(500);
  }
  return true;
}
function scoreHand(room,h){
  const g=room.game,p=handValue(h.cards).total,d=handValue(g.dealer).total,pbj=blackjack(h.cards),dbj=blackjack(g.dealer);
  let r=0;
  if(p>21)r=-1;
  else if(dbj&&!pbj)r=-1;
  else if(pbj&&!dbj)return 2;
  else if(d>21)r=1;
  else if(p>d)r=1;
  else if(p<d)r=-1;
  else r=0;
  return h.double?r*2:r;
}
function settlePlayer(room,p){let d=0;for(const h of p.hands)d+=scoreHand(room,h);p.score+=d;return d}
async function finishIfReady(room){
  const g=room.game;
  normalize(g.host);normalize(g.challenger);
  if(!(g.host.done&&g.challenger.done))return;
  if(g.phase!=='playing')return;

  // 즉시 dealer 단계로 잠가 중복 정산을 방지한다.
  g.phase='dealer';
  g.timerDeadline=null;
  const ok=await dealerPlayAnimated(room);
  if(!ok || rooms.get(room.code)!==room)return;

  const hd=settlePlayer(room,g.host),cd=settlePlayer(room,g.challenger);
  g.phase='result';g.timerDeadline=null;
  g.message=`ROUND ${g.round} 종료 · 블랙잭 킹 ${hd>=0?'+':''}${hd}점 / ${g.challenger.name} ${cd>=0?'+':''}${cd}점`;
  checkFinished(room);
  if(g.finished) broadcast(room);
  else scheduleAutoNextRound(room);
}

function scheduleAutoNextRound(room){
  const g=room.game;
  if(g.finished || g.phase!=='result') return;

  const expectedRound=g.round;
  g.nextRoundAt=Date.now()+5000;
  g.message += ' · 5초 후 다음 라운드 자동 시작';
  broadcast(room);

  setTimeout(()=>{
    if(rooms.get(room.code)!==room) return;
    if(g.finished || g.phase!=='result' || g.round!==expectedRound) return;

    g.nextRoundAt=null;
    g.round++;
    startRound(room);
  },5000);
}

function nextRound(room){const g=room.game;if(g.phase!=='result'||g.finished)return;g.nextRoundAt=null;g.round++;startRound(room)}

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    const g=room.game;if(!g.timerDeadline||now<g.timerDeadline)continue;
    if(g.phase==='playing'){
      for(const p of [g.host,g.challenger]){normalize(p);if(!p.done){const h=p.hands[p.activeHand];if(h)h.done=true;normalize(p)}}
      g.timerDeadline=null;g.message='공용 20초 종료 · 미완료 핸드는 자동 STAND 처리되었습니다.';broadcast(room);finishIfReady(room);
    }
  }
},250);

io.on('connection',socket=>{
  socket.on('createRoom',({password})=>{
    password=String(password||'').trim();
    if(password.length<4)return socket.emit('createRoomResult',{ok:false,message:'비밀번호는 4자 이상으로 설정하세요.'});
    const code=makeCode(),hostToken=crypto.randomBytes(24).toString('hex'),room=makeRoom(code,password,hostToken);
    rooms.set(code,room);socket.data.roomCode=code;socket.data.role='host';socket.data.hostToken=hostToken;
    room.game.host.connected=true;room.game.host.socketId=socket.id;socket.join('room:'+code);
    socket.emit('createRoomResult',{ok:true,code,hostToken,joinPath:'/join?room='+code});broadcast(room);
  });

  socket.on('resumeHost',({code,hostToken})=>{
    const room=getRoom(code);if(!room||room.hostToken!==hostToken)return socket.emit('hostResumeResult',{ok:false});
    socket.data.roomCode=room.code;socket.data.role='host';socket.data.hostToken=hostToken;room.game.host.connected=true;room.game.host.socketId=socket.id;socket.join('room:'+room.code);socket.emit('hostResumeResult',{ok:true});broadcast(room);
  });

  socket.on('joinRoom',({code,password,nickname})=>{
    const room=getRoom(code);if(!room)return socket.emit('joinRoomResult',{ok:false,message:'존재하지 않는 방입니다.'});
    if(room.passwordHash!==hash(password))return socket.emit('joinRoomResult',{ok:false,message:'방 비밀번호가 틀렸습니다.'});
    if(room.game.challenger.connected)return socket.emit('joinRoomResult',{ok:false,message:'이미 도전자가 입장해 있습니다.'});
    const clean=String(nickname||'').trim().slice(0,18);if(!clean)return socket.emit('joinRoomResult',{ok:false,message:'닉네임을 입력하세요.'});
    socket.data.roomCode=room.code;socket.data.role='challenger';room.game.challenger.connected=true;room.game.challenger.socketId=socket.id;room.game.challenger.name=clean;room.game.message='도전자 입장 완료 · 블랙잭 킹의 게임 시작을 기다리는 중입니다.';socket.join('room:'+room.code);socket.emit('joinRoomResult',{ok:true,code:room.code});broadcast(room);
  });
  socket.on('action',type=>{const room=getRoom(socket.data.roomCode);if(!room||!['host','challenger'].includes(socket.data.role)||!['hit','stand','double','split'].includes(type))return;action(room,socket.data.role,type)});
  socket.on('startGame',()=>{const room=getRoom(socket.data.roomCode);if(!room||socket.data.role!=='host')return;if(room.game.phase==='waiting'||room.game.phase==='idle')startRound(room)});
  socket.on('nextRound',()=>{const room=getRoom(socket.data.roomCode);if(!room||socket.data.role!=='host')return;nextRound(room)});

  socket.on('newMatch',({password})=>{
    const oldRoom=getRoom(socket.data.roomCode);if(!oldRoom||socket.data.role!=='host')return;
    password=String(password||'').trim();if(password.length<4)return socket.emit('newMatchResult',{ok:false,message:'새 비밀번호는 4자 이상이어야 합니다.'});
    const oldCode=oldRoom.code,challengerSocketId=oldRoom.game.challenger.socketId;
    if(challengerSocketId)io.to(challengerSocketId).emit('forcedLogout',{reason:'블랙잭 킹이 새 매치를 시작했습니다. 새 링크로 다시 입장해주세요.'});
    socket.leave('room:'+oldCode);rooms.delete(oldCode);
    let code=makeCode();while(code===oldCode||rooms.has(code))code=makeCode();
    const hostToken=crypto.randomBytes(24).toString('hex'),room=makeRoom(code,password,hostToken);
    room.game.host.connected=true;room.game.host.socketId=socket.id;room.game.message='새 매치 준비 완료 · 새 도전자를 기다리는 중입니다.';
    rooms.set(code,room);socket.join('room:'+code);socket.data.roomCode=code;socket.data.hostToken=hostToken;
    socket.emit('newMatchResult',{ok:true,code,hostToken,joinPath:'/join?room='+code});broadcast(room);
  });

  socket.on('disconnect',()=>{
    const room=getRoom(socket.data.roomCode);if(!room)return;
    if(socket.data.role==='host'){room.game.host.connected=false;room.game.message='블랙잭 킹 연결이 끊어졌습니다.'}
    if(socket.data.role==='challenger'){room.game.challenger.connected=false;room.game.message='도전자 연결이 끊어졌습니다.'}
    broadcast(room);
  });
});

server.listen(PORT,()=>console.log(`1v1 Blackjack server running on ${PORT}`));
